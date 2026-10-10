import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { harness, client } from "./helpers";
import * as s from "../db/schema";
import { flushOutbox } from "../jobs/reconcile";
import { hash } from "../security/tokens";

describe("Partiful-style private tabs", () => {
  test("separate DMs join one tab; proposal private, confirmation fans out exact shares once", async () => {
    const h = harness();
    const alex = h.direct.observedIdentity("alex@example.test");
    const ben = h.direct.observedIdentity("ben@example.test");
    const dm = (
      actorId: string,
      text: string,
      messageId: string = crypto.randomUUID(),
    ) => h.direct.handle({ actorId, text, messageId, provider: "photon" });
    await dm(alex, "name Alex");
    await dm(ben, "name Ben");
    const a = await dm(alex, "create Friday dinner", "create-once");
    const b = await dm(alex, "create Friday dinner", "create-once");
    expect(a).toEqual(b);
    expect(h.direct.list(alex, "photon")).toHaveLength(1);
    const groupId = a.groupId!;
    const invite = h.direct.invite(alex, groupId);
    expect(invite.url).toContain("/join#invite=");
    const joined = await dm(ben, `join ${invite.code}`);
    expect(joined.groupId).toBe(groupId);
    expect(h.ledger.groupMembers(groupId)).toHaveLength(2);
    expect(h.store.db.select().from(s.wallets).all()).toHaveLength(0);
    await dm(alex, "I paid $120 for groceries, split with everyone");
    expect(h.store.db.select().from(s.outbox).all()).toHaveLength(0);
    const expense = h.store.db
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.groupId, groupId))
      .get()!;
    await dm(alex, `confirm ${expense.id.slice(0, 8)}`, "confirm-once");
    await dm(alex, `confirm ${expense.id.slice(0, 8)}`, "confirm-once");
    const notifications = h.store.db.select().from(s.outbox).all();
    expect(notifications).toHaveLength(2);
    expect(notifications.map((n) => n.recipientId).sort()).toEqual(
      [alex, ben].sort(),
    );
    expect(
      notifications.every((n) => n.text.includes("Your share: $60.00")),
    ).toBe(true);
    expect(
      h.ledger.balances(groupId).find((b) => b.userId === ben)?.cents,
    ).toBe(-6000);
    expect(h.store.db.select().from(s.attempts).all()).toHaveLength(0);
    // Single flush guard and per-recipient durable retry; successful recipients are not repeated.
    const sends: string[] = [];
    const send = async (_g: unknown, _t: string, id?: string | null) => {
      sends.push(id!);
      if (id === ben) throw Error("provider unavailable");
    };
    await Promise.all([flushOutbox(h, send), flushOutbox(h, send)]);
    expect(sends.sort()).toEqual([alex, ben].sort());
    const failed = h.store.db
      .select()
      .from(s.outbox)
      .where(eq(s.outbox.recipientId, ben))
      .get()!;
    expect(failed.tries).toBe(1);
    expect(failed.state).toBe("pending");
    h.store.db
      .update(s.outbox)
      .set({ nextAt: 0 })
      .where(eq(s.outbox.id, failed.id))
      .run();
    await flushOutbox(h, async (_g, _t, id) => {
      sends.push(id!);
    });
    expect(sends.filter((id) => id === alex)).toHaveLength(1);
    expect(sends.filter((id) => id === ben)).toHaveLength(2);
    h.store.sqlite.close();
  });
  test("invite expiry/revocation, organizer-only creation and demo/live separation", () => {
    const h = harness();
    const group = h.direct.create("alex", "Dinner", "mock", "create");
    const invite = h.direct.invite("alex", group.id);
    expect(() => h.direct.join("ben", invite.code, "photon")).toThrow("demo");
    h.direct.join("ben", invite.code, "mock");
    expect(() => h.direct.invite("ben", group.id)).toThrow("organizer");
    expect(() => h.direct.revoke("ben", group.id)).toThrow("organizer");
    h.direct.revoke("alex", group.id);
    expect(() => h.direct.join("casey", invite.code, "mock")).toThrow(
      "revoked",
    );
    const expired = h.direct.invite("alex", group.id);
    h.store.db
      .update(s.tabInvites)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(s.tabInvites.hash, hash(expired.code)))
      .run();
    expect(() => h.direct.join("casey", expired.code, "mock")).toThrow(
      "expired",
    );
    expect(h.ledger.groupMembers(group.id)).toHaveLength(2);
    h.store.sqlite.close();
  });
  test("STOP suppresses pending and future updates, START does not replay; joining preserves prior splits", async () => {
    const h = harness();
    const group = h.direct.create("alex", "Dinner", "mock", "create");
    const invite = h.direct.invite("alex", group.id);
    h.direct.join("ben", invite.code, "mock");
    h.ledger.queue(group.id, "Update");
    await h.direct.handle({
      actorId: "ben",
      provider: "mock",
      messageId: "stop",
      text: "STOP",
    });
    expect(
      h.store.db
        .select()
        .from(s.outbox)
        .where(eq(s.outbox.recipientId, "ben"))
        .get()!.state,
    ).toBe("suppressed");
    const expense = h.ledger.propose("alex", {
      groupId: group.id,
      payerId: "alex",
      description: "Dinner",
      totalCents: 12000,
      currency: "USD",
      participants: ["alex", "ben"],
    });
    h.ledger.review(expense.id, "alex", "confirm");
    expect(
      h.store.db
        .select()
        .from(s.outbox)
        .where(eq(s.outbox.recipientId, "ben"))
        .all(),
    ).toHaveLength(1);
    h.direct.join("casey", invite.code, "mock");
    expect(
      h.ledger.balances(group.id).find((b) => b.userId === "casey")?.cents,
    ).toBe(0);
    await h.direct.handle({
      actorId: "ben",
      provider: "mock",
      messageId: "start",
      text: "START",
    });
    h.ledger.queue(group.id, "Next update");
    expect(
      h.store.db
        .select()
        .from(s.outbox)
        .where(
          and(eq(s.outbox.recipientId, "ben"), eq(s.outbox.state, "pending")),
        )
        .all(),
    ).toHaveLength(1);
    h.store.sqlite.close();
  });
  test("explicit active tab controls routing; unknown contacts never become members; PAY cannot move money", async () => {
    const h = harness();
    const a = h.direct.create("alex", "First", "mock", "first");
    const b = h.direct.create("alex", "Second", "mock", "second");
    const dm = (text: string) =>
      h.direct.handle({
        actorId: "alex",
        provider: "mock",
        messageId: crypto.randomUUID(),
        text,
      });
    await dm(`use ${a.id.slice(0, 8)}`);
    expect(h.direct.active("alex", "mock").id).toBe(a.id);
    expect((await dm("I paid $20 split with Unknown Person")).reply).toContain(
      "Name each split participant",
    );
    expect(h.ledger.groupMembers(a.id)).toHaveLength(1);
    expect((await dm("PAY")).reply).toContain("cannot authorize");
    expect(h.store.db.select().from(s.attempts).all()).toHaveLength(0);
    expect(() => h.direct.select("ben", b.id, "mock")).toThrow();
    h.store.sqlite.close();
  });
  test("API invite acceptance requires authentication, private notification text stays recipient-only", async () => {
    const h = harness();
    const c = client(h);
    expect(
      (await c.request("/api/tabs/join", { code: "x".repeat(24) })).response
        .status,
    ).toBe(401);
    await c.login("alex");
    const created = await c.request("/api/tabs", {
      name: "Dinner",
      idempotencyKey: "api-create",
    });
    const groupId = created.body.data.id;
    const invitation = await c.request(`/api/groups/${groupId}/invites`, {});
    await c.login("ben");
    expect(
      (await c.request("/api/tabs/join", { code: invitation.body.data.code }))
        .response.status,
    ).toBe(200);
    h.ledger.queue(groupId, "Alex-only message", "alex");
    h.ledger.queue(groupId, "Ben-only message", "ben");
    const details = await c.request(`/api/groups/${groupId}`);
    expect(
      details.body.data.messages.map((m: { text: string }) => m.text),
    ).toEqual(["Ben-only message"]);
    h.store.sqlite.close();
  });
  test("receipt bytes only read after active-tab check; absent Gemini is explicit", async () => {
    const h = harness();
    let reads = 0;
    const photo = async () => {
      reads++;
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    };
    await h.direct.handle({
      actorId: "alex",
      provider: "mock",
      messageId: "no-tab",
      text: "split this",
      attachment: photo,
    });
    expect(reads).toBe(0);
    h.direct.create("alex", "Dinner", "mock", "receipt-create");
    const result = await h.direct.handle({
      actorId: "alex",
      provider: "mock",
      messageId: "receipt",
      text: "split this with everyone",
      attachment: photo,
    });
    expect(reads).toBe(1);
    expect(result.reply).toContain("Gemini");
    expect(h.store.db.select().from(s.expenses).all()).toHaveLength(0);
    h.store.sqlite.close();
  });
});
