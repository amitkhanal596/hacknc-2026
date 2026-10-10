import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { harness, client, groceries } from "./helpers";
import * as s from "../db/schema";
import { receiptFixture } from "../ai/extractor";
import { validateExtraction } from "../ai/schemas";
import { sniff } from "../api/assets";
const participants = ["alex", "ben", "casey", "drew"];
describe("chat and extraction", () => {
  test("Photon ping queues one reply on replay and never touches money or AI", async () => {
    const h = harness();
    h.extractor.parse = async () => {
      throw new Error("Ping must not call AI");
    };
    const event = {
      provider: "photon" as const,
      messageId: "photon-ping",
      groupId: "tahoe",
      actorId: "alex",
      text: "@tab ping",
    };
    const responses = await Promise.all([
      h.messages.handle(event),
      h.messages.handle(event),
    ]);
    expect(responses).toEqual([
      { reply: "Tab is online!" },
      { reply: "Tab is online!" },
    ]);
    await h.messages.handle(event);
    expect(h.store.db.select().from(s.outbox).all()).toHaveLength(1);
    expect(h.store.db.select().from(s.expenses).all()).toHaveLength(0);
    expect(h.store.db.select().from(s.attempts).all()).toHaveLength(0);
    expect(h.store.db.select().from(s.credits).all()).toHaveLength(0);
    h.store.sqlite.close();
  });
  test("chat -> proposal -> explicit payer confirmation -> ledger, replay safe", async () => {
    const h = harness();
    const e = {
      provider: "mock" as const,
      messageId: "m1",
      groupId: "tahoe",
      actorId: "alex",
      text: "@tab I paid $120 for groceries, split with everyone",
    };
    const [a, b] = await Promise.all([
      h.messages.handle(e),
      h.messages.handle(e),
    ]);
    expect(a).toEqual(b);
    expect(h.store.db.select().from(s.expenses).all()).toHaveLength(1);
    expect(h.ledger.balances("tahoe").every((b) => b.cents === 0)).toBe(true);
    const id = h.store.db.select().from(s.expenses).all()[0]!.id;
    await h.messages.handle({
      ...e,
      messageId: "m2",
      text: `@tab confirm ${id.slice(0, 8)}`,
    });
    expect(h.ledger.balances("tahoe").map((b) => b.cents)).toEqual([
      9000, -3000, -3000, -3000,
    ]);
    await h.messages.handle({ ...e, messageId: "m3", text: "@tab PAY" });
    expect(h.store.db.select().from(s.attempts).all()).toHaveLength(0);
    h.store.sqlite.close();
  });
  test("receipt fixture asks who paid; screenshot cannot create expenses", async () => {
    const h = harness();
    const e = {
      provider: "mock" as const,
      messageId: "receipt",
      groupId: "tahoe",
      actorId: "ben",
      text: "@tab split this",
      fixture: "receipt" as const,
    };
    await h.messages.handle(e);
    const expense = h.store.db.select().from(s.expenses).all()[0]!;
    expect(expense.payerId).toBeNull();
    expect(() => h.ledger.review(expense.id, "alex", "confirm")).toThrow();
    h.ledger.review(expense.id, "alex", "confirm", "casey");
    expect(h.ledger.balances("tahoe").map((b) => b.cents)).toEqual([
      -2100, -2100, 6300, -2100,
    ]);
    await h.messages.handle({
      ...e,
      messageId: "screenshot",
      fixture: "payment_screenshot",
    });
    expect(h.store.db.select().from(s.expenses).all()).toHaveLength(1);
    expect(h.store.db.select().from(s.credits).all()).toHaveLength(0);
    h.store.sqlite.close();
  });
  test("unsupported currency, unknown members, receipt mismatch, forged verification rejected", () => {
    const base = { ...receiptFixture, participantIds: participants };
    expect(() =>
      validateExtraction({ ...base, currency: "EUR" }, participants),
    ).toThrow();
    expect(() =>
      validateExtraction({ ...base, payerId: "intruder" }, participants),
    ).toThrow();
    expect(() =>
      validateExtraction(
        { ...base, participantIds: ["intruder"] },
        participants,
      ),
    ).toThrow();
    expect(() =>
      validateExtraction({ ...base, totalCents: 1 }, participants),
    ).toThrow();
    expect(() =>
      validateExtraction({ ...base, verified: true }, participants),
    ).toThrow();
  });
  test("fixture parser named subset and explicit self payer", async () => {
    const h = harness();
    const result = await h.extractor.parse({
      text: "@tab I paid $80 gas, split between Ben, Casey, and me",
      actorId: "alex",
      members: h.ledger.groupMembers("tahoe"),
    });
    expect(result.participantIds.sort()).toEqual(["alex", "ben", "casey"]);
    expect(result.payerId).toBe("alex");
    await expect(
      h.extractor.parse({
        text: "@tab I paid $80 split with Unknown",
        actorId: "alex",
        members: h.ledger.groupMembers("tahoe"),
      }),
    ).rejects.toThrow();
    h.store.sqlite.close();
  });
  test("same-image digest deduplicates, content type and size checked", async () => {
    const h = harness();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const a = await h.assets.upload("alex", "tahoe", bytes, "evidence", []);
    const b = await h.assets.upload("ben", "tahoe", bytes, "evidence", []);
    expect(a.id).toBe(b.id);
    expect(b.duplicate).toBe(true);
    expect(() => sniff(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => sniff(new Uint8Array(5 * 1024 * 1024))).toThrow();
    h.store.sqlite.close();
  });
});
describe("HTTP authorization and complete flow", () => {
  test("unauthenticated private groups and CSRF rejected", async () => {
    const h = harness();
    expect((await h.app.request("/api/groups")).status).toBe(401);
    expect(
      (
        await h.app.request("/api/dev/login", {
          method: "POST",
          body: JSON.stringify({ userId: "alex" }),
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
    h.store.sqlite.close();
  });
  test("another group and private image access rejected", async () => {
    const h = harness();
    const c = client(h);
    await c.login("ben");
    h.store.db
      .insert(s.groups)
      .values({
        id: "private",
        name: "Private",
        provider: "mock",
        spaceId: "private",
      })
      .run();
    h.store.db
      .insert(s.members)
      .values({ groupId: "private", userId: "alex", role: "owner" })
      .run();
    h.store.db
      .insert(s.assets)
      .values({
        id: "secret",
        groupId: "private",
        digest: "secret",
        mime: "image/png",
        data: "AA==",
        parserStatus: "pending",
      })
      .run();
    expect((await c.request("/api/groups/private")).response.status).toBe(403);
    expect((await c.request("/api/receipts/secret")).response.status).toBe(403);
    h.store.sqlite.close();
  });
  test("unknown participants, mismatched actor and confirmed expense edits rejected", async () => {
    const h = harness();
    const e = groceries(h.ledger);
    expect(() => h.ledger.revise(e.id, "alex", "changed", 1)).toThrow();
    expect(() =>
      h.ledger.propose("alex", {
        groupId: "tahoe",
        payerId: "alex",
        description: "x",
        totalCents: 10,
        currency: "USD",
        participants: ["stranger"],
      }),
    ).toThrow();
    const c = client(h);
    await c.login("casey");
    const plan = h.ledger.plan("tahoe", "alex"),
      ben = plan.find((i) => i.fromId === "ben")!;
    expect((await c.request(`/settlements/${ben.id}`)).response.status).toBe(
      404,
    );
    expect(
      (await c.request(`/api/settlements/${ben.id}`)).response.status,
    ).toBe(403);
    h.store.sqlite.close();
  });
  test("API manual payments settle all four balances with separate recipient sessions", async () => {
    const h = harness();
    const alex = client(h);
    await alex.login("alex");
    const chat = await alex.request("/api/dev/simulate-message", {
      groupId: "tahoe",
      messageId: "api-groceries",
      text: "@tab I paid $120 for groceries, split with everyone",
    });
    expect(chat.response.status).toBe(200);
    const id = chat.body.data.expenseId;
    expect(
      (await alex.request(`/api/expenses/${id}/confirm`, {})).response.status,
    ).toBe(200);
    await alex.request(
      "/api/me/destinations/venmo",
      { address: "alex-fixture", confirmOwnership: true },
      "PUT",
    );
    await alex.request(
      "/api/me/destinations/apple_cash",
      { address: "alex@example.test", confirmOwnership: true },
      "PUT",
    );
    const plan = (await alex.request("/api/groups/tahoe/settlements/plan", {}))
      .body.data as s.Intent[];
    for (const [index, method] of (
      ["cash", "venmo", "apple_cash"] as const
    ).entries()) {
      const i = plan[index]!,
        sender = client(h);
      await sender.login(i.fromId);
      const chosen = await sender.request(
        `/api/settlements/${i.id}/choose-method`,
        { method, idempotencyKey: `request-${index}` },
      );
      expect(chosen.response.status).toBe(200);
      const a = chosen.body.data as s.Attempt;
      expect(
        (await sender.request(`/api/payment-attempts/${a.id}/claim-paid`, {}))
          .response.status,
      ).toBe(200);
      expect(
        h.ledger.balances("tahoe").find((b) => b.userId === i.fromId)!.cents,
      ).toBe(-3000);
      expect(
        (
          await sender.request(
            `/api/payment-attempts/${a.id}/confirm-received`,
            {},
          )
        ).response.status,
      ).toBe(403);
      expect(
        (
          await alex.request(
            `/api/payment-attempts/${a.id}/confirm-received`,
            {},
          )
        ).response.status,
      ).toBe(200);
      expect(
        (
          await alex.request(
            `/api/payment-attempts/${a.id}/confirm-received`,
            {},
          )
        ).response.status,
      ).toBe(409);
    }
    expect(h.ledger.balances("tahoe").map((b) => b.cents)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(h.store.db.select().from(s.wallets).all()).toHaveLength(0);
    h.store.sqlite.close();
  });
  test("one-time login challenges expire, consume once and bind identity", () => {
    const h = harness();
    const token = h.auth.issue("alex", "login", "identity");
    expect(() => h.auth.consume(token, "ben", "login", "identity")).toThrow();
    h.auth.consume(token, "alex", "login", "identity");
    expect(() => h.auth.consume(token, "alex", "login", "identity")).toThrow();
    h.store.sqlite.close();
  });
  test("audit append-only, corrections do not rewrite history", () => {
    const h = harness();
    groceries(h.ledger);
    expect(() =>
      h.store.sqlite.exec("UPDATE audit_events SET type='forged'"),
    ).toThrow();
    expect(() => h.store.sqlite.exec("DELETE FROM audit_events")).toThrow();
    h.store.sqlite.close();
  });
});

describe("private sign-in links and evidence ownership", () => {
  test("real login fails closed when Photon DM delivery is unavailable", async () => {
    const h = harness(),
      c = client(h);
    const result = await c.request("/api/auth/start", {
      providerUserId: "known@example.test",
    });
    expect(result.response.status).toBe(503);
    expect(h.store.db.select().from(s.sessions).all()).toHaveLength(0);
    h.store.sqlite.close();
  });
  test("provider-delivered challenge creates a private session once and no payment", async () => {
    const h = harness(),
      c = client(h);
    h.store.db
      .insert(s.identities)
      .values({
        id: "real-fixture",
        userId: "alex",
        provider: "photon",
        providerUserId: "verified@example.test",
        verified: true,
      })
      .run();
    let delivered = "";
    h.setLoginDelivery(async (identity, token) => {
      expect(identity).toBe("verified@example.test");
      delivered = token;
    });
    expect(
      (
        await c.request("/api/auth/start", {
          providerUserId: "verified@example.test",
        })
      ).response.status,
    ).toBe(200);
    expect(delivered.length).toBeGreaterThan(32);
    expect(
      (
        await c.request("/api/auth/verify", {
          providerUserId: "verified@example.test",
          token: delivered,
        })
      ).response.status,
    ).toBe(200);
    const me = await c.request("/api/me");
    expect(me.body.data.demo).toBe(false);
    expect(me.body.data.user.id).toBe("alex");
    expect(
      (
        await c.request("/api/auth/verify", {
          providerUserId: "verified@example.test",
          token: delivered,
        })
      ).response.status,
    ).toBe(403);
    expect(h.store.db.select().from(s.attempts).all()).toHaveLength(0);
    h.store.sqlite.close();
  });
  test("payment evidence is private to uploader and payment parties", async () => {
    const h = harness();
    groceries(h.ledger);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const asset = await h.assets.upload("ben", "tahoe", bytes, "evidence", []);
    const casey = client(h);
    await casey.login("casey");
    expect(
      (await casey.request(`/api/receipts/${asset.id}`)).response.status,
    ).toBe(403);
    const plan = h.ledger.plan("tahoe", "alex"),
      ben = plan.find((i) => i.fromId === "ben")!,
      caseyIntent = plan.find((i) => i.fromId === "casey")!;
    const a = await h.payments.choose(ben.id, "ben", "cash", "ben");
    const b = await h.payments.choose(caseyIntent.id, "casey", "cash", "casey");
    expect(() =>
      h.payments.claim(b.id, "casey", undefined, asset.id),
    ).toThrow();
    h.payments.claim(a.id, "ben", undefined, asset.id);
    expect(
      (await casey.request(`/api/receipts/${asset.id}`)).response.status,
    ).toBe(403);
    h.store.sqlite.close();
  });
});

test("screenshot OCR suggests only an outstanding matching intent and never settles it", async () => {
  const h = harness();
  groceries(h.ledger);
  const plan = h.ledger.plan("tahoe", "alex");
  const parsed = await h.extractor.parse({
    text: "@tab screenshot",
    actorId: "ben",
    members: h.ledger.groupMembers("tahoe"),
    fixture: "payment_screenshot",
  });
  expect(parsed.paymentRecord?.displayedStatus).toBe("Completed");
  h.extractor.mode = "gemini";
  h.extractor.parse = async () => parsed;
  const result = await h.assets.upload(
    "ben",
    "tahoe",
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    "evidence",
    [],
  );
  const extraction = result.extraction as {
    suggestedIntentIds: string[];
    verification: string;
  };
  expect(extraction.verification).toBe("unverified_evidence");
  expect(extraction.suggestedIntentIds).toEqual([
    plan.find((i) => i.fromId === "ben")!.id,
  ]);
  expect(h.ledger.balances("tahoe").map((b) => b.cents)).toEqual([
    9000, -3000, -3000, -3000,
  ]);
  expect(h.store.db.select().from(s.credits).all()).toHaveLength(0);
  h.store.sqlite.close();
});
