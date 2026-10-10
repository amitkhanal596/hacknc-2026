import { describe, test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { harness, groceries, fixture } from "./helpers";
import * as s from "../db/schema";
import { verifyTransaction } from "../solana/verify";
import { ManualRail } from "../payments/manual";
import { uid } from "../domain/ledger";
describe("payment state machine", () => {
  test.each(["venmo", "apple_cash", "zelle", "cash"] as const)(
    "%s claim is untrusted; recipient confirmation settles once",
    async (method) => {
      const h = harness();
      groceries(h.ledger);
      h.store.db
        .insert(s.destinations)
        .values({
          id: uid(),
          userId: "alex",
          method,
          address: "recipient-supplied-fixture",
          hint: "TEST ONLY",
          verified: true,
        })
        .run();
      const i = h.ledger.plan("tahoe", "ben").find((i) => i.fromId === "ben")!;
      const a = await h.payments.choose(i.id, "ben", method, "key");
      expect("executeAuthorized" in new ManualRail(method)).toBe(false);
      h.payments.claim(a.id, "ben", "Screenshot says paid");
      expect(
        h.ledger.balances("tahoe").find((b) => b.userId === "ben")!.cents,
      ).toBe(-3000);
      expect(() => h.payments.confirm(a.id, "ben")).toThrow();
      expect(() => h.payments.confirm(a.id, "casey")).toThrow();
      h.payments.confirm(a.id, "alex");
      expect(
        h.ledger.balances("tahoe").find((b) => b.userId === "ben")!.cents,
      ).toBe(0);
      expect(() => h.payments.confirm(a.id, "alex")).toThrow();
      expect(h.store.db.select().from(s.credits).all()).toHaveLength(1);
      h.store.sqlite.close();
    },
  );
  test("no recipient destination is invented", async () => {
    const h = harness();
    groceries(h.ledger);
    const i = h.ledger.plan("tahoe", "ben")[0]!;
    await expect(
      h.payments.choose(i.id, i.fromId, "venmo", "key"),
    ).rejects.toThrow();
    expect(h.store.db.select().from(s.wallets).all()).toHaveLength(0);
    h.store.sqlite.close();
  });
  test("single plan, single attempt, idempotency and stale plan", async () => {
    const h = harness();
    groceries(h.ledger);
    const plan = h.ledger.plan("tahoe", "alex");
    expect(h.ledger.plan("tahoe", "ben").map((i) => i.id)).toEqual(
      plan.map((i) => i.id),
    );
    const i = plan[0]!;
    const [a, b] = await Promise.all([
      h.payments.choose(i.id, i.fromId, "cash", "a"),
      h.payments.choose(i.id, i.fromId, "cash", "b"),
    ]);
    expect(a.id).toBe(b.id);
    await expect(
      h.payments.choose(i.id, i.fromId, "solana", "c"),
    ).rejects.toThrow();
    h.ledger.cancelPlan("tahoe", "alex");
    await expect(
      h.payments.choose(i.id, i.fromId, "cash", "d"),
    ).rejects.toThrow();
    h.store.sqlite.close();
  });
  test("new confirmed expenses cannot invalidate active plan", () => {
    const h = harness();
    groceries(h.ledger);
    h.ledger.plan("tahoe", "alex");
    const e = h.ledger.propose("alex", {
      groupId: "tahoe",
      payerId: "alex",
      description: "Dinner",
      totalCents: 1000,
      currency: "USD",
      participants: ["alex", "ben"],
    });
    expect(() => h.ledger.review(e.id, "alex", "confirm")).toThrow();
    h.store.sqlite.close();
  });
  test("disputed claim cannot settle, retry or cancel", async () => {
    const h = harness();
    groceries(h.ledger);
    const i = h.ledger.plan("tahoe", "alex")[0]!;
    const a = await h.payments.choose(i.id, i.fromId, "cash", "a");
    h.payments.claim(a.id, i.fromId);
    h.payments.dispute(a.id, i.toId);
    expect(() => h.payments.confirm(a.id, i.toId)).toThrow();
    expect(() => h.payments.cancel(a.id, i.fromId)).toThrow();
    expect(() => h.ledger.cancelPlan("tahoe", "alex")).toThrow();
    h.store.sqlite.close();
  });
  test("expired intention rejected", async () => {
    const h = harness();
    groceries(h.ledger);
    const i = h.ledger.plan("tahoe", "alex")[0]!;
    h.store.db
      .update(s.intents)
      .set({ expiresAt: 0 })
      .where(eq(s.intents.id, i.id))
      .run();
    await expect(
      h.payments.choose(i.id, i.fromId, "cash", "a"),
    ).rejects.toThrow();
    h.store.sqlite.close();
  });
  test("Solana explicit approval with RPC fixture applies exactly once; double click rejected", async () => {
    const h = harness();
    groceries(h.ledger);
    const i = h.ledger.plan("tahoe", "alex")[0]!;
    const a = await h.payments.choose(i.id, i.fromId, "solana", "a");
    const auth = h.payments.approval(a.id, i.fromId);
    await expect(
      h.payments.authorize(a.id, "casey", auth.token, i.amountCents, i.toId),
    ).rejects.toThrow();
    await expect(
      h.payments.authorize(a.id, i.fromId, auth.token, 1, i.toId),
    ).rejects.toThrow();
    const results = await Promise.allSettled([
      h.payments.authorize(a.id, i.fromId, auth.token, i.amountCents, i.toId),
      h.payments.authorize(a.id, i.fromId, auth.token, i.amountCents, i.toId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.fixtureRail.calls).toBe(1);
    expect(h.ledger.attempt(a.id).status).toBe("onchain_verified");
    expect(
      h.ledger.balances("tahoe").find((b) => b.userId === i.fromId)!.cents,
    ).toBe(0);
    h.store.sqlite.close();
  });
  test("expired approval rejected", async () => {
    const h = harness();
    groceries(h.ledger);
    const i = h.ledger.plan("tahoe", "alex")[0]!;
    const a = await h.payments.choose(i.id, i.fromId, "solana", "a");
    const auth = h.payments.approval(a.id, i.fromId);
    h.store.db.update(s.tokens).set({ expiresAt: 0 }).run();
    await expect(
      h.payments.authorize(a.id, i.fromId, auth.token, i.amountCents, i.toId),
    ).rejects.toThrow();
    expect(h.fixtureRail.calls).toBe(0);
    h.store.sqlite.close();
  });
  test("duplicate transaction signatures and over-confirmation blocked", async () => {
    const h = harness();
    groceries(h.ledger);
    const plan = h.ledger.plan("tahoe", "alex");
    const a = await h.payments.choose(
      plan[0]!.id,
      plan[0]!.fromId,
      "solana",
      "a",
    );
    const b = await h.payments.choose(
      plan[1]!.id,
      plan[1]!.fromId,
      "solana",
      "b",
    );
    h.store.db
      .update(s.attempts)
      .set({ signature: "same-signature" })
      .where(eq(s.attempts.id, a.id))
      .run();
    expect(() =>
      h.store.db
        .update(s.attempts)
        .set({ signature: "same-signature" })
        .where(eq(s.attempts.id, b.id))
        .run(),
    ).toThrow();
    expect(() =>
      h.store.db
        .update(s.intents)
        .set({ confirmedCents: 3001 })
        .where(eq(s.intents.id, plan[0]!.id))
        .run(),
    ).toThrow();
    h.store.sqlite.close();
  });
});
describe("Solana exact finalized transaction verification", () => {
  test("accept exact finalized fixture", () => {
    const { tx, expected } = fixture();
    expect(verifyTransaction(tx, expected, true)).toBe(true);
  });
  test.each([
    "mint",
    "destination",
    "source",
    "units",
    "sender",
    "recipient",
    "reference",
    "signature",
  ] as const)("reject wrong %s", (field) => {
    const { tx, expected } = fixture();
    expect(() =>
      verifyTransaction(tx, { ...expected, [field]: "wrong" }, true),
    ).toThrow();
  });
  test("reject failed tx, missing tx and insufficient finality", () => {
    const { tx, expected } = fixture();
    expect(() => verifyTransaction(tx, expected, false)).toThrow();
    expect(() => verifyTransaction(null, expected, true)).toThrow();
    tx.meta!.err = { InstructionError: [0, "InvalidArgument"] };
    expect(() => verifyTransaction(tx, expected, true)).toThrow();
  });
  test("reject balance mismatch even if parsed instruction looks correct", () => {
    const { tx, expected } = fixture();
    tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount = "1";
    expect(() => verifyTransaction(tx, expected, true)).toThrow();
  });
});

describe("RPC uncertainty recovery", () => {
  test("reconciliation rebroadcasts only persisted bytes, never a new transaction", async () => {
    const h = harness();
    groceries(h.ledger);
    const i = h.ledger.plan("tahoe", "alex")[0]!;
    const a = await h.payments.choose(i.id, i.fromId, "solana", "recover");
    h.store.db
      .update(s.attempts)
      .set({
        status: "submitted",
        signature: "uncertain",
        rawTransaction: Buffer.from("same signed transaction").toString(
          "base64",
        ),
        lastValidBlockHeight: 1000,
        chainExpected: "{}",
      })
      .where(eq(s.attempts.id, a.id))
      .run();
    const broadcasts: string[] = [];
    h.solana.connection.getSignatureStatuses = async () => ({
      context: { slot: 1 },
      value: [null],
    });
    h.solana.connection.getBlockHeight = async () => 500;
    h.solana.connection.sendRawTransaction = async (bytes) => {
      broadcasts.push(Buffer.from(bytes).toString());
      return "uncertain";
    };
    h.solana.verify = async () => false;
    await h.solana.reconcile(a.id);
    await h.solana.reconcile(a.id);
    expect(broadcasts).toEqual([
      "same signed transaction",
      "same signed transaction",
    ]);
    expect(h.ledger.attempt(a.id).status).toBe("submitted");
    expect(
      h.ledger.balances("tahoe").find((b) => b.userId === i.fromId)!.cents,
    ).toBe(-3000);
    h.solana.connection.getBlockHeight = async () => 2000;
    await h.solana.reconcile(a.id);
    expect(broadcasts).toHaveLength(2);
    expect(h.ledger.attempt(a.id).status).toBe("submitted");
    h.store.sqlite.close();
  });
  test("concurrent confirmation yields exactly one ledger credit", async () => {
    const h = harness();
    groceries(h.ledger);
    const i = h.ledger.plan("tahoe", "alex")[0]!;
    const a = await h.payments.choose(i.id, i.fromId, "cash", "race");
    h.payments.claim(a.id, i.fromId);
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => h.payments.confirm(a.id, i.toId)),
      Promise.resolve().then(() => h.payments.confirm(a.id, i.toId)),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(h.store.db.select().from(s.credits).all()).toHaveLength(1);
    h.store.sqlite.close();
  });
});
