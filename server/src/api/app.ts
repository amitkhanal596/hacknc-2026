import { Hono } from "hono";
import { z } from "zod";
import { explain } from "../bot/explain";
import { disputeShare, handleDM } from "../bot/handler";
import { ensureMessagingAccess, joinGroup } from "../bot/join";
import { PhotonRegistrationError } from "../messaging/photon-users";
import { normalizeHandle } from "../messaging/types";
import type { Ctx } from "../context";
import { flagBadges } from "../copy";
import { groupDebts, payableCents } from "../ledger/debts";
import { formatCents as $ } from "../ledger/money";
import { newId } from "../ids";
import {
  createApplePayIntent,
  handleStripeEvent,
  notifyCreditor,
  paySolana,
  payLinkUrl,
  payoutsOnboardingLink,
  PayoutsUnavailableError,
  readPayLink,
  refreshPayoutStatus,
} from "../payments/service";
import {
  applyShareAction,
  auditForExpense,
  expensesOf,
  getExpense,
  getShare,
  pendingSharesFor,
  shareDetail,
  sharesOf,
  userSharesInGroup,
} from "../store/expenses";
import { createGroup, getGroup, getGroupByCode, groupsOf, isMember, membersOf } from "../store/groups";
import { paymentsOf } from "../store/payments";
import { getOrCreateUser, getUser, getUserByStripeAccount, nameOf, updateUser } from "../store/users";
import { joinedPage, joinPage, messagePage, payPage } from "../web/pages";
import { startLogin, userIdFromBearer, verifyLogin } from "./auth";
import { joinInvite } from "../copy";
import type { User } from "../db/schema";

type Env = { Variables: { user: User } };

const publicUser = (u: User | undefined) => (u ? { id: u.id, name: nameOf(u), phone: u.phone } : null);

export function createApp(ctx: Ctx) {
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------- auth (extension login)
  app.post("/auth/start", async (c) => {
    const body = z.object({ phone: z.string().min(7) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ message: "Send { phone }." }, 400);
    const r = await startLogin(ctx, body.data.phone);
    return c.json(r, r.ok ? 200 : 429);
  });

  app.post("/auth/verify", async (c) => {
    const body = z.object({ phone: z.string(), code: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ message: "Send { phone, code }." }, 400);
    const r = verifyLogin(ctx, body.data.phone, body.data.code);
    if (!r.ok) return c.json(r, 401);
    return c.json({ token: r.token, user: publicUser(getUser(ctx, r.userId)) });
  });

  // ---------------------------------------------------------------- extension API (bearer token)
  const api = new Hono<Env>();
  api.use("*", async (c, next) => {
    const userId = userIdFromBearer(ctx, c.req.header("authorization"));
    const user = userId ? getUser(ctx, userId) : undefined;
    if (!user) return c.json({ message: "Not signed in." }, 401);
    c.set("user", user);
    await next();
  });

  /** Loads a group the caller belongs to, or responds 404. */
  const memberGroup = (groupId: string, user: User) => (isMember(ctx, groupId, user.id) ? getGroup(ctx, groupId) : undefined);

  api.get("/me", (c) => c.json({ user: publicUser(c.get("user")), pendingCount: pendingSharesFor(ctx, c.get("user").id).length }));

  api.get("/groups", (c) => {
    const user = c.get("user");
    return c.json({
      groups: groupsOf(ctx, user.id).map((g) => ({ id: g.id, name: g.name, kind: g.kind, joinCode: g.joinCode, active: g.id === user.activeGroupId })),
    });
  });

  api.post("/groups", async (c) => {
    const body = z.object({ name: z.string().min(1).max(60), kind: z.enum(["trip", "roommates", "dinner", "club"]).default("trip") }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ message: "Send { name, kind? }." }, 400);
    const g = createGroup(ctx, c.get("user"), body.data.name, body.data.kind);
    return c.json({ group: g, invite: joinInvite(g, ctx.config) }, 201);
  });

  api.get("/groups/:id", (c) => {
    const user = c.get("user");
    const group = memberGroup(c.req.param("id"), user);
    if (!group) return c.json({ message: "Not found." }, 404);
    const members = membersOf(ctx, group.id);
    const nameById = new Map(members.map((m) => [m.id, nameOf(m)]));
    const debts = groupDebts(ctx, group.id).map((d) => ({ ...d, from: nameById.get(d.fromId), to: nameById.get(d.toId), amount: $(d.cents) }));
    const myShares = new Map(userSharesInGroup(ctx, user.id, group.id).map((d) => [d.expense.id, d.share]));
    return c.json({
      group: { id: group.id, name: group.name, kind: group.kind, joinCode: group.joinCode },
      members: members.map(publicUser),
      expenses: expensesOf(ctx, group.id)
        .filter((e) => e.status === "active")
        .map((e) => ({
          id: e.id,
          description: e.description,
          totalCents: e.totalCents,
          total: $(e.totalCents),
          payer: nameById.get(e.payerId),
          payerId: e.payerId,
          flags: e.flags,
          badges: flagBadges(e.flags, e.receiptTotalCents),
          createdAt: e.createdAt,
          myShare: myShares.get(e.id) ? { id: myShares.get(e.id)!.id, cents: myShares.get(e.id)!.cents, status: myShares.get(e.id)!.status } : null,
        })),
      debts,
      iOwe: debts.filter((d) => d.fromId === user.id),
      owedToMe: debts.filter((d) => d.toId === user.id),
      pending: pendingSharesFor(ctx, user.id)
        .filter((p) => p.group.id === group.id)
        .map((p) => ({ shareId: p.share.id, expenseId: p.expense.id, description: p.expense.description, cents: p.share.cents, payer: nameOf(p.payer), autoApproveAt: p.share.autoApproveAt })),
      payments: paymentsOf(ctx, group.id).map((p) => ({ ...p, from: nameById.get(p.fromId), to: nameById.get(p.toId) })),
    });
  });

  /** Same pipeline as texting the bot: the result (and any follow-up question) arrives by DM. */
  api.post("/groups/:id/expenses", async (c) => {
    const user = c.get("user");
    const group = memberGroup(c.req.param("id"), user);
    if (!group) return c.json({ message: "Not found." }, 404);
    updateUser(ctx, user.id, { activeGroupId: group.id });

    const contentType = c.req.header("content-type") ?? "";
    if (contentType.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("image");
      const text = form.get("text");
      if (!(file instanceof File)) return c.json({ message: "Attach an image field." }, 400);
      const data = Buffer.from(await file.arrayBuffer());
      await handleDM(ctx, {
        id: newId("ext"),
        from: user.phone,
        text: typeof text === "string" ? text : null,
        images: [{ name: file.name, mimeType: file.type || "image/jpeg", read: async () => data }],
        at: new Date(ctx.now()),
      });
    } else {
      const body = z.object({ text: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ message: "Send { text } or a multipart image." }, 400);
      await handleDM(ctx, { id: newId("ext"), from: user.phone, text: body.data.text, images: [], at: new Date(ctx.now()) });
    }
    return c.json({ ok: true, message: "Sent to Tab. Check your messages for the confirmation." }, 202);
  });

  api.get("/expenses/:id", (c) => {
    const user = c.get("user");
    const expense = getExpense(ctx, c.req.param("id"));
    if (!expense || !isMember(ctx, expense.groupId, user.id)) return c.json({ message: "Not found." }, 404);
    const shares = sharesOf(ctx, expense.id);
    return c.json({
      expense: { ...expense, total: $(expense.totalCents), payer: nameOf(getUser(ctx, expense.payerId)), badges: flagBadges(expense.flags, expense.receiptTotalCents) },
      shares: shares.map((s) => ({ ...s, name: nameOf(getUser(ctx, s.userId)), amount: $(s.cents), mine: s.userId === user.id })),
      audit: auditForExpense(ctx, expense.id).map((a) => ({ ...a, actor: a.actorId ? nameOf(getUser(ctx, a.actorId)) : "Tab" })),
    });
  });

  // Only the share's owner can approve or dispute it (also enforced in the ledger).
  api.post("/shares/:id/approve", (c) => {
    const user = c.get("user");
    const share = getShare(ctx, c.req.param("id"));
    if (!share) return c.json({ message: "Not found." }, 404);
    if (share.userId !== user.id) return c.json({ message: "You can only approve your own share." }, 403);
    const r = applyShareAction(ctx, share.id, { type: "approve", actorId: user.id, via: "extension" });
    return r.ok ? c.json({ share: r.share }) : c.json({ message: r.error }, 409);
  });

  api.post("/shares/:id/dispute", async (c) => {
    const user = c.get("user");
    const body = z.object({ reason: z.string().min(1).max(300) }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ message: "Send { reason }." }, 400);
    const share = getShare(ctx, c.req.param("id"));
    if (!share) return c.json({ message: "Not found." }, 404);
    if (share.userId !== user.id) return c.json({ message: "You can only dispute your own share." }, 403);
    const detail = shareDetail(ctx, share.id)!;
    if (!(await disputeShare(ctx, user, detail, body.data.reason))) return c.json({ message: "That share can't be disputed." }, 409);
    return c.json({ share: getShare(ctx, share.id) });
  });

  api.get("/explain", (c) => {
    const user = c.get("user");
    const group = memberGroup(c.req.query("groupId") ?? "", user);
    if (!group) return c.json({ message: "Not found." }, 404);
    const creditor = c.req.query("creditor");
    return c.json({ text: explain(ctx, user, group, creditor && isMember(ctx, group.id, creditor) ? creditor : undefined) });
  });

  api.post("/pay/solana", async (c) => {
    const user = c.get("user");
    const body = z.object({ groupId: z.string(), toUserId: z.string(), cents: z.number().int().positive().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ message: "Send { groupId, toUserId, cents? }." }, 400);
    if (!memberGroup(body.data.groupId, user)) return c.json({ message: "Not found." }, 404);
    const r = await paySolana(ctx, { groupId: body.data.groupId, fromId: user.id, toId: body.data.toUserId, cents: body.data.cents });
    if (!r.ok) return c.json(r, 409);
    await notifyCreditor(ctx, r.payment, r.explorerUrl);
    return c.json({ payment: r.payment, explorerUrl: r.explorerUrl });
  });

  api.post("/pay/link", async (c) => {
    const user = c.get("user");
    const body = z.object({ groupId: z.string(), toUserId: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ message: "Send { groupId, toUserId }." }, 400);
    if (!memberGroup(body.data.groupId, user)) return c.json({ message: "Not found." }, 404);
    return c.json({ url: payLinkUrl(ctx, body.data.groupId, user.id, body.data.toUserId) });
  });

  api.post("/connect/onboard", async (c) => {
    try {
      const url = await payoutsOnboardingLink(ctx, c.get("user").id);
      return url ? c.json({ url }) : c.json({ message: "Stripe isn't configured." }, 501);
    } catch (err) {
      if (err instanceof PayoutsUnavailableError) return c.json({ message: "Bank payouts aren't enabled on this server's Stripe account yet." }, 503);
      throw err;
    }
  });

  app.route("/api", api);

  // ---------------------------------------------------------------- join page (the invite link)
  app.get("/j/:code", (c) => {
    const group = getGroupByCode(ctx, c.req.param("code"));
    if (!group) return c.html(messagePage("Invite not found", "Double-check the link with whoever invited you."), 404);
    return c.html(joinPage({ code: group.joinCode, groupName: group.name, members: membersOf(ctx, group.id).map(nameOf) }));
  });

  app.post("/j/:code", async (c) => {
    const group = getGroupByCode(ctx, c.req.param("code"));
    if (!group) return c.html(messagePage("Invite not found", "Double-check the link with whoever invited you."), 404);
    const form = await c.req.parseBody();
    const name = String(form.name ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
    const rawPhone = String(form.phone ?? "").trim();
    const phone = normalizeHandle(rawPhone);
    const again = (error: string) =>
      c.html(joinPage({ code: group.joinCode, groupName: group.name, members: membersOf(ctx, group.id).map(nameOf), error, phone: rawPhone, name }), 422);
    if (!name) return again("Add your first name.");
    if (!/^\+[1-9]\d{9,14}$/.test(phone)) return again("Enter a full phone number, like (919) 555-1234.");

    let user = getOrCreateUser(ctx, phone);
    if (!user.displayName) user = updateUser(ctx, user.id, { displayName: name });
    let line: string | undefined;
    try {
      line = await ensureMessagingAccess(ctx, user);
    } catch (err) {
      console.error("[join] messaging registration failed:", (err as Error).message);
      return again(err instanceof PhotonRegistrationError ? err.message : "Couldn't set up texting right now. Try again in a minute.");
    }
    await joinGroup(ctx, getUser(ctx, user.id)!, group, user.displayName ? undefined : name);
    return c.html(joinedPage({ groupName: group.name, line, code: group.joinCode }));
  });

  // ---------------------------------------------------------------- pay page (signed link, no login)
  app.get("/p/:token", (c) => {
    const token = c.req.param("token");
    const link = readPayLink(ctx, token);
    if (!link) return c.html(messagePage("Link expired", "Text SETTLE to the bot for a fresh pay link."), 410);
    const group = getGroup(ctx, link.groupId)!;
    const creditor = getUser(ctx, link.toId)!;
    const cents = payableCents(ctx, link.groupId, link.fromId, link.toId);
    if (cents <= 0) return c.html(messagePage("All paid up", `You don't owe ${nameOf(creditor)} anything in ${group.name} right now.`));

    const lines = userSharesInGroup(ctx, link.fromId, group.id)
      .filter((d) => d.payer.id === creditor.id && d.share.status === "approved")
      .map((d) => ({ label: d.expense.description, amount: $(d.share.cents) }));
    const offsets = userSharesInGroup(ctx, creditor.id, group.id).filter((d) => d.payer.id === link.fromId && d.share.status === "approved");
    for (const d of offsets) lines.push({ label: `${nameOf(creditor)}'s share of ${d.expense.description}`, amount: `−${$(d.share.cents)}` });
    for (const p of paymentsOf(ctx, group.id)) {
      if (p.fromId === link.fromId && p.toId === creditor.id && ["confirmed", "held", "released"].includes(p.status)) {
        lines.push({ label: "Already paid", amount: `−${$(p.cents)}` });
      }
    }
    return c.html(payPage({ token, groupName: group.name, creditorName: nameOf(creditor), amount: $(cents), cents, lines, publishableKey: ctx.stripe?.publishableKey }));
  });

  app.post("/p/:token/intent", async (c) => {
    const r = await createApplePayIntent(ctx, c.req.param("token"));
    return r.ok ? c.json({ clientSecret: r.clientSecret, cents: r.cents }) : c.json(r, 409);
  });

  app.post("/p/:token/usdc", async (c) => {
    const link = readPayLink(ctx, c.req.param("token"));
    if (!link) return c.html(messagePage("Link expired", "Text SETTLE to the bot for a fresh pay link."), 410);
    const r = await paySolana(ctx, { groupId: link.groupId, fromId: link.fromId, toId: link.toId });
    if (!r.ok) return c.html(messagePage("Couldn't pay", r.message), 409);
    await notifyCreditor(ctx, r.payment, r.explorerUrl);
    return c.html(messagePage("✅ Paid", `Sent ${$(r.payment.cents)} in USDC to ${nameOf(getUser(ctx, link.toId))}.`));
  });

  app.get("/p/:token/done", (c) => c.html(messagePage("✅ Payment submitted", "You'll get a text as soon as it's confirmed.")));

  // ---------------------------------------------------------------- Stripe
  app.post("/stripe/webhook", async (c) => {
    if (!ctx.stripe) return c.json({ message: "Stripe isn't configured." }, 501);
    let event;
    try {
      event = ctx.stripe.parseWebhook(await c.req.text(), c.req.header("stripe-signature"));
    } catch (err) {
      return c.json({ message: (err as Error).message }, 400);
    }
    await handleStripeEvent(ctx, event);
    return c.json({ received: true });
  });

  app.get("/connect/return", async (c) => {
    const user = getUserByStripeAccount(ctx, c.req.query("account") ?? "");
    const ready = user ? await refreshPayoutStatus(ctx, user.id).catch(() => false) : false;
    return c.html(
      ready
        ? messagePage("✅ You're set up", "Apple Pay payments to you will land in your bank. You can close this page.")
        : messagePage("Almost there", "Stripe is still reviewing your details. I'll text you when payouts are ready."),
    );
  });

  app.get("/connect/refresh", async (c) => {
    const user = getUserByStripeAccount(ctx, c.req.query("account") ?? "");
    if (!user || !ctx.stripe) return c.html(messagePage("Link expired", "Text PAYOUTS to the bot for a new setup link."), 410);
    return c.redirect(await ctx.stripe.onboardingLink(user.stripeAccountId!));
  });

  return app;
}
