import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config";
import type { Store } from "../db/client";
import * as s from "../db/schema";
import { seed, demoPeople } from "../db/seed";
import { Ledger, uid } from "../domain/ledger";
import { DomainError, ensure } from "../domain/money";
import { Auth, hash } from "../security/tokens";
import { Extractor } from "../ai/extractor";
import { MessageHandler } from "../messaging/handler";
import { DirectTabs } from "../messaging/direct-tabs";
import { Payments } from "../payments/service";
import { SolanaRail } from "../payments/solana-devnet";
import { methods, type PaymentRail } from "../payments/types";
import { Assets } from "./assets";
const nonempty = z.string().min(1).max(200);
const proposal = z.object({
  payerId: nonempty.nullable(),
  description: z.string().min(1).max(500),
  totalCents: z.number().int().positive().max(1_000_000),
  currency: z.literal("USD").default("USD"),
  participants: z.array(nonempty).min(1).max(100),
  weights: z.array(z.number().int().positive()).optional(),
  shares: z
    .array(
      z.object({ userId: nonempty, cents: z.number().int().nonnegative() }),
    )
    .optional(),
  idempotencyKey: nonempty,
});
export type Runtime = ReturnType<typeof createApp>;
export function publicAttempt(a: s.Attempt) {
  const { rawTransaction: _raw, chainExpected: _expected, ...safe } = a;
  return {
    ...safe,
    explorerUrl: a.signature
      ? `https://explorer.solana.com/tx/${a.signature}?cluster=devnet`
      : null,
  };
}
export function createApp(
  store: Store,
  config: Config,
  railOverride?: PaymentRail,
) {
  const ledger = new Ledger(store.db),
    auth = new Auth(store.db),
    extractor = new Extractor(config),
    messages = new MessageHandler(ledger, extractor),
    solana = new SolanaRail(ledger, config),
    payments = new Payments(ledger, auth, railOverride ?? solana),
    assets = new Assets(ledger, extractor),
    direct = new DirectTabs(ledger, messages, assets, config.APP_BASE_URL);
  let deliverLogin:
    ((providerId: string, token: string) => Promise<void>) | null = null;
  let photonState = config.PHOTON_ENABLED ? "connecting" : "simulation";
  const app = new Hono<{ Variables: { userId: string; scope: string } }>();
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "blob:", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 6 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { error: { code: "BODY_SIZE", message: "Request too large." } },
          413,
        ),
    }),
  );
  const rates = new Map<string, { count: number; until: number }>();
  const rate = (key: string, limit: number, window = 60_000) => {
    if (rates.size > 10000)
      for (const [k, v] of rates) if (v.until < Date.now()) rates.delete(k);
    const current = rates.get(key);
    const value =
      current && current.until > Date.now()
        ? current
        : { count: 0, until: Date.now() + window };
    ensure(
      ++value.count <= limit,
      "RATE_LIMIT",
      "Too many requests. Try again shortly.",
      429,
    );
    rates.set(key, value);
  };
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      ensure(
        c.req.header("origin") === new URL(config.APP_BASE_URL).origin &&
          c.req.header("x-tab-request") === "1",
        "CSRF",
        "Use the same-origin Tab application.",
        403,
      );
    }
    if (
      ["/api/auth/start", "/api/auth/verify"].includes(c.req.path) ||
      c.req.path === "/api/dev/login"
    ) {
      rate("auth-global", 60);
      await next();
      return;
    }
    const session = auth.lookup(getCookie(c, "tab_session") ?? "");
    ensure(
      session,
      "UNAUTHENTICATED",
      "Sign in to view your private trip.",
      401,
    );
    c.set("userId", session.userId);
    c.set("scope", session.scope);
    rate(`user:${session.userId}`, 120);
    await next();
  });
  app.notFound((c) =>
    c.json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404),
  );
  app.onError((error, c) => {
    if (error instanceof DomainError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status as 400,
      );
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: {
            code: "VALIDATION",
            message: "Invalid request. Check required fields and amounts.",
          },
        },
        400,
      );
    if (error instanceof SyntaxError)
      return c.json({ error: { code: "JSON", message: "Invalid JSON." } }, 400);
    console.error("Tab request failed:", error.name);
    return c.json(
      {
        error: {
          code: "INTERNAL",
          message:
            "Operation could not complete. No unverified payment was credited.",
        },
      },
      500,
    );
  });
  const cookie = (c: Parameters<typeof setCookie>[0], token: string) =>
    setCookie(c, "tab_session", token, {
      httpOnly: true,
      secure: config.APP_BASE_URL.startsWith("https:"),
      sameSite: "Strict",
      path: "/",
      maxAge: 8 * 3600,
    });
  const scopeGroup = (groupId: string, actor: string, scope: string) => {
    ledger.member(groupId, actor);
    const group = store.db
      .select()
      .from(s.groups)
      .where(eq(s.groups.id, groupId))
      .get()!;
    ensure(
      scope !== "demo" || group.provider === "mock",
      "FORBIDDEN",
      "Demo sessions cannot access real groups.",
      403,
    );
    return group;
  };
  const guardExpense = (id: string, actor: string, scope: string) => {
    const e = ledger.expense(id);
    scopeGroup(e.groupId, actor, scope);
    return e;
  };
  const guardIntent = (id: string, actor: string, scope: string) => {
    const i = ledger.intent(id);
    scopeGroup(i.groupId, actor, scope);
    ensure(
      i.fromId === actor || i.toId === actor,
      "FORBIDDEN",
      "Only payment participants can view this intent.",
      403,
    );
    return i;
  };
  const guardAttempt = (id: string, actor: string, scope: string) => {
    const a = ledger.attempt(id);
    guardIntent(a.intentId, actor, scope);
    return a;
  };
  app.get("/health", (c) => c.json({ ok: true, service: "tab" }));
  app.post("/api/dev/login", async (c) => {
    ensure(config.DEMO_MODE, "NOT_FOUND", "Not found.", 404);
    const { userId } = z
      .object({ userId: z.enum(["alex", "ben", "casey", "drew"]) })
      .parse(await c.req.json());
    seed(store.db);
    cookie(c, auth.session(userId, "demo"));
    return c.json({ data: { userId, mode: "DEMO — identity simulation" } });
  });
  app.post("/api/auth/start", async (c) => {
    const { providerUserId } = z
      .object({ providerUserId: nonempty })
      .parse(await c.req.json());
    ensure(
      deliverLogin,
      "DM_UNAVAILABLE",
      "Verified Photon DM delivery is unavailable. Real login is disabled.",
      503,
    );
    rate(`login:${hash(providerUserId)}`, 3, 600_000);
    const identity = store.db
      .select()
      .from(s.identities)
      .where(
        and(
          eq(s.identities.provider, "photon"),
          eq(s.identities.providerUserId, providerUserId),
          eq(s.identities.verified, true),
        ),
      )
      .get();
    if (identity) {
      const token = auth.issue(identity.userId, "login", providerUserId);
      await deliverLogin(providerUserId, token);
    }
    return c.json({
      data: {
        message:
          "If this is a known verified messaging identity, a one-time code has been sent privately.",
      },
    });
  });
  app.post("/api/auth/verify", async (c) => {
    const body = z
      .object({ providerUserId: nonempty, token: z.string().min(32).max(200) })
      .parse(await c.req.json());
    const identity = store.db
      .select()
      .from(s.identities)
      .where(
        and(
          eq(s.identities.provider, "photon"),
          eq(s.identities.providerUserId, body.providerUserId),
          eq(s.identities.verified, true),
        ),
      )
      .get();
    ensure(identity, "AUTH_FAILED", "Invalid authentication challenge.", 403);
    store.db.transaction(() => {
      auth.consume(body.token, identity.userId, "login", body.providerUserId);
      cookie(c, auth.session(identity.userId, "photon"));
    });
    return c.json({ data: { userId: identity.userId } });
  });
  app.post("/api/auth/logout", (c) => {
    store.db
      .delete(s.sessions)
      .where(eq(s.sessions.hash, hash(getCookie(c, "tab_session") ?? "")))
      .run();
    deleteCookie(c, "tab_session", { path: "/" });
    return c.json({ data: { ok: true } });
  });
  app.get("/api/me", (c) =>
    c.json({
      data: {
        user: store.db
          .select({ id: s.users.id, name: s.users.name })
          .from(s.users)
          .where(eq(s.users.id, c.get("userId")))
          .get(),
        demo: c.get("scope") === "demo",
        modes: {
          ai: extractor.mode,
          messaging: photonState,
          solana: solana.capability.available ? "devnet_demo" : "unavailable",
        },
        demoPeople: config.DEMO_MODE ? demoPeople : [],
        wallet: solana.wallet(c.get("userId"))?.address ?? null,
      },
    }),
  );
  app.put("/api/me/profile", async (c) => {
    const b = z
      .object({ name: z.string().trim().min(1).max(60) })
      .parse(await c.req.json());
    store.db
      .update(s.users)
      .set({ name: b.name })
      .where(eq(s.users.id, c.get("userId")))
      .run();
    return c.json({ data: { saved: true } });
  });
  app.get("/api/groups", (c) => {
    const rows = store.db
      .select({ group: s.groups })
      .from(s.groups)
      .innerJoin(s.members, eq(s.groups.id, s.members.groupId))
      .where(eq(s.members.userId, c.get("userId")))
      .all();
    return c.json({
      data: rows
        .map((r) => r.group)
        .filter((g) => c.get("scope") !== "demo" || g.provider === "mock"),
    });
  });
  app.post("/api/tabs", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        idempotencyKey: nonempty,
      })
      .parse(await c.req.json());
    return c.json({
      data: direct.create(
        c.get("userId"),
        body.name,
        c.get("scope") === "demo" ? "mock" : "photon",
        body.idempotencyKey,
      ),
    });
  });
  app.post("/api/tabs/join", async (c) => {
    const { code } = z
      .object({ code: z.string().min(16).max(100) })
      .parse(await c.req.json());
    return c.json({
      data: direct.join(
        c.get("userId"),
        code,
        c.get("scope") === "demo" ? "mock" : "photon",
      ),
    });
  });
  app.post("/api/groups/:id/invites", (c) => {
    scopeGroup(c.req.param("id"), c.get("userId"), c.get("scope"));
    return c.json({ data: direct.invite(c.get("userId"), c.req.param("id")) });
  });
  app.post("/api/groups/:id/invites/revoke", (c) => {
    scopeGroup(c.req.param("id"), c.get("userId"), c.get("scope"));
    direct.revoke(c.get("userId"), c.req.param("id"));
    return c.json({ data: { revoked: true } });
  });
  app.post("/api/dev/direct-message", async (c) => {
    ensure(
      config.DEMO_MODE && c.get("scope") === "demo",
      "NOT_FOUND",
      "Not found.",
      404,
    );
    const body = z
      .object({
        text: z.string().max(4000),
        messageId: nonempty,
        groupId: nonempty.optional(),
      })
      .parse(await c.req.json());
    if (body.groupId) direct.select(c.get("userId"), body.groupId, "mock");
    return c.json({
      data: await direct.handle({
        provider: "mock",
        actorId: c.get("userId"),
        messageId: body.messageId,
        text: body.text,
      }),
    });
  });
  app.get("/api/groups/:id", (c) => {
    const group = scopeGroup(
      c.req.param("id"),
      c.get("userId"),
      c.get("scope"),
    );
    const groupExpenses = store.db
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.groupId, group.id))
      .all();
    const groupIntents = store.db
      .select()
      .from(s.intents)
      .where(eq(s.intents.groupId, group.id))
      .all();
    const visible = groupIntents.filter(
      (i) => i.fromId === c.get("userId") || i.toId === c.get("userId"),
    );
    const groupAttempts = visible.length
      ? store.db
          .select()
          .from(s.attempts)
          .where(
            inArray(
              s.attempts.intentId,
              visible.map((i) => i.id),
            ),
          )
          .all()
          .map(publicAttempt)
      : [];
    return c.json({
      data: {
        ...group,
        direct: ledger.isDirect(group.id),
        members: ledger.groupMembers(group.id),
        expenses: groupExpenses.map((e) => ({
          ...e,
          shares: store.db
            .select()
            .from(s.shares)
            .where(eq(s.shares.expenseId, e.id))
            .all(),
        })),
        balances: ledger.balances(group.id),
        intents: visible,
        activePlan: ledger.pending(group.id).length > 0,
        attempts: groupAttempts,
        activity: store.db
          .select({
            id: s.audit.id,
            type: s.audit.type,
            actorId: s.audit.actorId,
            createdAt: s.audit.createdAt,
            entityId: s.audit.entityId,
          })
          .from(s.audit)
          .where(eq(s.audit.groupId, group.id))
          .orderBy(desc(s.audit.createdAt))
          .limit(40)
          .all(),
        messages: store.db
          .select({
            id: s.outbox.id,
            text: s.outbox.text,
            state: s.outbox.state,
          })
          .from(s.outbox)
          .where(
            and(
              eq(s.outbox.groupId, group.id),
              or(
                isNull(s.outbox.recipientId),
                eq(s.outbox.recipientId, c.get("userId")),
              ),
            ),
          )
          .orderBy(desc(s.outbox.createdAt))
          .limit(20)
          .all(),
      },
    });
  });
  app.get("/api/groups/:id/expenses", (c) => {
    scopeGroup(c.req.param("id"), c.get("userId"), c.get("scope"));
    return c.json({
      data: store.db
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.groupId, c.req.param("id")))
        .all(),
    });
  });
  app.get("/api/groups/:id/balances", (c) => {
    scopeGroup(c.req.param("id"), c.get("userId"), c.get("scope"));
    return c.json({ data: ledger.balances(c.req.param("id")) });
  });
  app.post("/api/groups/:id/expenses/propose", async (c) => {
    const groupId = c.req.param("id");
    scopeGroup(groupId, c.get("userId"), c.get("scope"));
    const body = proposal.parse(await c.req.json());
    return c.json({
      data: ledger.propose(c.get("userId"), {
        ...body,
        groupId,
        sourceId: `web:${c.get("userId")}:${body.idempotencyKey}`,
      }),
    });
  });
  for (const action of ["confirm", "reject"] as const)
    app.post(`/api/expenses/:id/${action}`, async (c) => {
      guardExpense(c.req.param("id"), c.get("userId"), c.get("scope"));
      const b = z
        .object({
          payerId: nonempty.optional(),
          version: z.number().int().positive().optional(),
        })
        .parse(await c.req.json());
      return c.json({
        data: ledger.review(
          c.req.param("id"),
          c.get("userId"),
          action,
          b.payerId,
          b.version,
        ),
      });
    });
  app.post("/api/expenses/:id/change", async (c) => {
    guardExpense(c.req.param("id"), c.get("userId"), c.get("scope"));
    const b = z
      .object({
        description: z.string().min(1).max(500),
        totalCents: z.number().int().positive(),
      })
      .parse(await c.req.json());
    return c.json({
      data: ledger.revise(
        c.req.param("id"),
        c.get("userId"),
        b.description,
        b.totalCents,
      ),
    });
  });
  app.post("/api/groups/:id/settlements/plan", (c) => {
    scopeGroup(c.req.param("id"), c.get("userId"), c.get("scope"));
    return c.json({ data: ledger.plan(c.req.param("id"), c.get("userId")) });
  });
  app.post("/api/groups/:id/settlements/cancel", (c) => {
    scopeGroup(c.req.param("id"), c.get("userId"), c.get("scope"));
    return c.json({
      data: ledger.cancelPlan(c.req.param("id"), c.get("userId")),
    });
  });
  app.get("/api/settlements/:id", (c) =>
    c.json({
      data: guardIntent(c.req.param("id"), c.get("userId"), c.get("scope")),
    }),
  );
  app.post("/api/settlements/:id/choose-method", async (c) => {
    guardIntent(c.req.param("id"), c.get("userId"), c.get("scope"));
    rate(`attempt:${c.get("userId")}`, 15);
    const b = z
      .object({ method: z.enum(methods), idempotencyKey: nonempty })
      .parse(await c.req.json());
    return c.json({
      data: publicAttempt(
        await payments.choose(
          c.req.param("id"),
          c.get("userId"),
          b.method,
          b.idempotencyKey,
        ),
      ),
    });
  });
  app.get("/api/settlements/:id/instructions", (c) => {
    const i = guardIntent(c.req.param("id"), c.get("userId"), c.get("scope"));
    const a = store.db
      .select()
      .from(s.attempts)
      .where(eq(s.attempts.intentId, i.id))
      .orderBy(desc(s.attempts.createdAt))
      .get();
    ensure(a, "METHOD_REQUIRED", "Choose a payment method.");
    return c.json({ data: JSON.parse(a.destination) as unknown });
  });
  app.get("/api/payments/methods", (c) =>
    c.json({ data: [...payments.rails.values()].map((r) => r.capability) }),
  );
  app.post("/api/payment-attempts/:id/approval", (c) => {
    guardAttempt(c.req.param("id"), c.get("userId"), c.get("scope"));
    return c.json({
      data: payments.approval(c.req.param("id"), c.get("userId")),
    });
  });
  app.post("/api/payment-attempts/:id/authorize-solana", async (c) => {
    guardAttempt(c.req.param("id"), c.get("userId"), c.get("scope"));
    const b = z
      .object({
        token: nonempty,
        amountCents: z.number().int().positive(),
        recipientId: nonempty,
      })
      .parse(await c.req.json());
    return c.json({
      data: publicAttempt(
        await payments.authorize(
          c.req.param("id"),
          c.get("userId"),
          b.token,
          b.amountCents,
          b.recipientId,
        ),
      ),
    });
  });
  app.post("/api/payment-attempts/:id/claim-paid", async (c) => {
    guardAttempt(c.req.param("id"), c.get("userId"), c.get("scope"));
    const b = z
      .object({
        note: z.string().max(500).optional(),
        assetId: nonempty.optional(),
      })
      .parse(await c.req.json());
    return c.json({
      data: publicAttempt(
        payments.claim(c.req.param("id"), c.get("userId"), b.note, b.assetId),
      ),
    });
  });
  for (const [route, action] of [
    ["confirm-received", "confirm"],
    ["dispute", "dispute"],
    ["cancel", "cancel"],
  ] as const)
    app.post(`/api/payment-attempts/:id/${route}`, (c) => {
      guardAttempt(c.req.param("id"), c.get("userId"), c.get("scope"));
      return c.json({
        data: publicAttempt(
          payments[action](c.req.param("id"), c.get("userId")),
        ),
      });
    });
  app.get("/api/payment-attempts/:id/status", (c) =>
    c.json({
      data: publicAttempt(
        guardAttempt(c.req.param("id"), c.get("userId"), c.get("scope")),
      ),
    }),
  );
  app.post("/api/payment-attempts/:id/reconcile", async (c) => {
    guardAttempt(c.req.param("id"), c.get("userId"), c.get("scope"));
    return c.json({
      data: publicAttempt(await solana.reconcile(c.req.param("id"))),
    });
  });
  app.get("/api/me/destinations", (c) =>
    c.json({
      data: store.db
        .select()
        .from(s.destinations)
        .where(eq(s.destinations.userId, c.get("userId")))
        .all(),
    }),
  );
  app.put("/api/me/destinations/:method", async (c) => {
    const method = z
      .enum(["venmo", "apple_cash", "zelle", "cash"])
      .parse(c.req.param("method"));
    const b = z
      .object({
        address: z.string().trim().min(1).max(120),
        confirmOwnership: z.literal(true),
      })
      .parse(await c.req.json());
    ensure(
      !/[<>\r\n]/.test(b.address),
      "DESTINATION",
      "Use a plain handle or contact.",
    );
    if (method === "venmo")
      ensure(
        /^@?[A-Za-z0-9_-]{2,30}$/.test(b.address),
        "DESTINATION",
        "Use your Venmo handle.",
      );
    if (["apple_cash", "zelle"].includes(method))
      ensure(
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.address) ||
          /^\+?[\d ()-]{7,20}$/.test(b.address),
        "DESTINATION",
        "Use your enrolled email or phone.",
      );
    const userId = c.get("userId");
    store.db
      .insert(s.destinations)
      .values({
        id: uid(),
        userId,
        method,
        address: b.address,
        hint: "Confirmed by recipient; not provider-verified",
        verified: true,
      })
      .onConflictDoUpdate({
        target: [s.destinations.userId, s.destinations.method],
        set: { address: b.address, verified: true },
      })
      .run();
    return c.json({ data: { saved: true } });
  });
  app.post("/api/me/devnet-wallet", async (c) => {
    rate(`wallet:${c.get("userId")}`, 2, 3600_000);
    return c.json({
      data: {
        address: await solana.provision(c.get("userId")),
        token: "TAB Test USD (tUSD), devnet only, no real value",
      },
    });
  });
  app.post("/api/dev/simulate-message", async (c) => {
    ensure(
      config.DEMO_MODE && c.get("scope") === "demo",
      "NOT_FOUND",
      "Not found.",
      404,
    );
    const b = z
      .object({
        groupId: nonempty,
        messageId: nonempty,
        text: z.string().min(1).max(2000),
      })
      .parse(await c.req.json());
    scopeGroup(b.groupId, c.get("userId"), c.get("scope"));
    return c.json({
      data: await messages.handle({
        ...b,
        actorId: c.get("userId"),
        provider: "mock",
      }),
    });
  });
  app.post("/api/dev/simulate-receipt", async (c) => {
    ensure(
      config.DEMO_MODE && c.get("scope") === "demo",
      "NOT_FOUND",
      "Not found.",
      404,
    );
    const b = z
      .object({
        groupId: nonempty,
        fixture: z.enum(["receipt", "payment_screenshot"]),
      })
      .parse(await c.req.json());
    scopeGroup(b.groupId, c.get("userId"), c.get("scope"));
    return c.json({
      data: await messages.handle({
        ...b,
        messageId: `fixture:${b.fixture}:${b.groupId}`,
        text: "@tab split this",
        actorId: c.get("userId"),
        provider: "mock",
      }),
    });
  });
  app.post("/api/dev/new-scenario", (c) => {
    ensure(
      config.DEMO_MODE && c.get("scope") === "demo",
      "NOT_FOUND",
      "Not found.",
      404,
    );
    return c.json({ data: seed(store.db, true) });
  });
  app.post("/api/receipts/upload", async (c) => {
    const form = await c.req.formData();
    const groupId = nonempty.parse(form.get("groupId"));
    scopeGroup(groupId, c.get("userId"), c.get("scope"));
    const file = form.get("file");
    ensure(file instanceof File, "FILE", "Choose an image.");
    const purpose = z
      .enum(["expense", "evidence"])
      .parse(form.get("purpose") || "expense");
    const participants = z
      .array(nonempty)
      .parse(JSON.parse(String(form.get("participants") || "[]")));
    return c.json({
      data: await assets.upload(
        c.get("userId"),
        groupId,
        new Uint8Array(await file.arrayBuffer()),
        purpose,
        participants,
      ),
    });
  });
  app.get("/api/receipts/:id", (c) => {
    const asset = store.db
      .select()
      .from(s.assets)
      .where(eq(s.assets.id, c.req.param("id")))
      .get();
    ensure(asset, "NOT_FOUND", "Receipt not found.", 404);
    scopeGroup(asset.groupId, c.get("userId"), c.get("scope"));
    const linkedEvidence = store.db
      .select()
      .from(s.evidence)
      .where(eq(s.evidence.assetId, asset.id))
      .all();
    if (asset.purpose === "evidence" && asset.uploader !== c.get("userId")) {
      ensure(
        linkedEvidence.length > 0,
        "FORBIDDEN",
        "Private payment evidence.",
        403,
      );
      for (const e of linkedEvidence)
        payments.party(e.attemptId, c.get("userId"));
    }
    ensure(asset.data, "EXPIRED_ASSET", "This private image has expired.", 410);
    c.header("Content-Type", asset.mime);
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(Buffer.from(asset.data, "base64"));
  });
  return {
    app,
    ledger,
    auth,
    extractor,
    messages,
    direct,
    payments,
    solana,
    assets,
    store,
    config,
    setLoginDelivery(fn: typeof deliverLogin) {
      deliverLogin = fn;
    },
    setPhotonState(state: string) {
      photonState = state;
    },
  };
}
