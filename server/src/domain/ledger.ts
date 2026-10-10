import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { cents, ensure, formatMoney } from "./money";
import { customShares, split, type Share } from "./split";
import { settle } from "./settle";
export const uid = () => crypto.randomUUID();
export class Ledger {
  constructor(public db: Db) {}
  member(groupId: string, userId: string) {
    const m = this.db
      .select()
      .from(s.members)
      .where(and(eq(s.members.groupId, groupId), eq(s.members.userId, userId)))
      .get();
    ensure(m, "FORBIDDEN", "Group membership required.", 403);
    return m;
  }
  groupMembers(groupId: string) {
    return this.db
      .select({ id: s.users.id, name: s.users.name, role: s.members.role })
      .from(s.members)
      .innerJoin(s.users, eq(s.members.userId, s.users.id))
      .where(eq(s.members.groupId, groupId))
      .all()
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  log(
    groupId: string,
    actorId: string | null,
    type: string,
    entityId: string,
    details: object = {},
  ) {
    this.db
      .insert(s.audit)
      .values({
        id: uid(),
        groupId,
        actorId,
        type,
        entityId,
        details: JSON.stringify(details),
      })
      .run();
  }
  isDirect(groupId: string) {
    const group = this.db
      .select()
      .from(s.groups)
      .where(eq(s.groups.id, groupId))
      .get();
    return group?.spaceId.startsWith("dm-tab:") ?? false;
  }
  queue(groupId: string, text: string, recipientId?: string) {
    const recipients = recipientId
      ? [recipientId]
      : this.isDirect(groupId)
        ? this.groupMembers(groupId).map((m) => m.id)
        : [null];
    for (const recipient of recipients) {
      if (recipient) {
        this.member(groupId, recipient);
        const preference = this.db
          .select()
          .from(s.dmPreferences)
          .where(eq(s.dmPreferences.userId, recipient))
          .get();
        if (preference?.enabled === false) continue;
      }
      this.db
        .insert(s.outbox)
        .values({ id: uid(), groupId, text, recipientId: recipient })
        .run();
    }
  }
  expense(id: string) {
    const e = this.db
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, id))
      .get();
    ensure(e, "NOT_FOUND", "Expense not found.", 404);
    return e;
  }
  intent(id: string) {
    const i = this.db
      .select()
      .from(s.intents)
      .where(eq(s.intents.id, id))
      .get();
    ensure(i, "NOT_FOUND", "Settlement not found.", 404);
    return i;
  }
  attempt(id: string) {
    const a = this.db
      .select()
      .from(s.attempts)
      .where(eq(s.attempts.id, id))
      .get();
    ensure(a, "NOT_FOUND", "Payment attempt not found.", 404);
    return a;
  }
  pending(groupId: string) {
    return this.db
      .select()
      .from(s.intents)
      .where(
        and(eq(s.intents.groupId, groupId), eq(s.intents.status, "pending")),
      )
      .all();
  }
  balances(groupId: string) {
    const net = new Map(this.groupMembers(groupId).map((m) => [m.id, 0]));
    const add = (id: string, n: number) => {
      ensure(net.has(id), "CORRUPT_LEDGER", "Ledger member missing.");
      const total = net.get(id)! + n;
      ensure(
        Number.isSafeInteger(total),
        "OVERFLOW",
        "Balance exceeds integer range.",
      );
      net.set(id, total);
    };
    for (const e of this.db
      .select()
      .from(s.expenses)
      .where(
        and(
          eq(s.expenses.groupId, groupId),
          eq(s.expenses.status, "confirmed"),
        ),
      )
      .all()) {
      ensure(e.payerId, "CORRUPT_LEDGER", "Confirmed expense has no payer.");
      add(e.payerId, e.totalCents);
      for (const sh of this.db
        .select()
        .from(s.shares)
        .where(eq(s.shares.expenseId, e.id))
        .all())
        add(sh.userId, -sh.cents);
    }
    for (const c of this.db
      .select()
      .from(s.credits)
      .where(eq(s.credits.groupId, groupId))
      .all()) {
      add(c.fromId, c.cents);
      add(c.toId, -c.cents);
    }
    const result = [...net].map(([userId, cents]) => ({ userId, cents }));
    ensure(
      result.reduce((a, b) => a + b.cents, 0) === 0,
      "CORRUPT_LEDGER",
      "Ledger does not conserve value.",
    );
    return result;
  }
  propose(
    actor: string,
    input: {
      groupId: string;
      payerId: string | null;
      description: string;
      totalCents: number;
      currency: string;
      participants: string[];
      weights?: number[];
      shares?: Share[];
      sourceId?: string;
    },
  ) {
    this.member(input.groupId, actor);
    cents(input.totalCents);
    ensure(input.currency === "USD", "CURRENCY", "USD only.");
    ensure(
      input.description.trim().length > 0 && input.description.length <= 500,
      "DESCRIPTION",
      "Description required.",
    );
    if (input.payerId) this.member(input.groupId, input.payerId);
    const allocation = input.shares
      ? customShares(input.totalCents, input.shares)
      : split(input.totalCents, input.participants, input.weights);
    for (const sh of allocation) this.member(input.groupId, sh.userId);
    return this.db.transaction(() => {
      if (input.sourceId) {
        const existing = this.db
          .select()
          .from(s.expenses)
          .where(
            and(
              eq(s.expenses.groupId, input.groupId),
              eq(s.expenses.sourceId, input.sourceId),
            ),
          )
          .get();
        if (existing) return existing;
      }
      const id = uid();
      this.db
        .insert(s.expenses)
        .values({
          id,
          groupId: input.groupId,
          payerId: input.payerId,
          totalCents: input.totalCents,
          description: input.description,
          createdBy: actor,
          sourceId: input.sourceId,
        })
        .run();
      this.db
        .insert(s.shares)
        .values(allocation.map((sh) => ({ ...sh, expenseId: id })))
        .run();
      this.log(input.groupId, actor, "expense_proposed", id);
      return this.expense(id);
    });
  }
  review(
    id: string,
    actor: string,
    action: "confirm" | "reject",
    payerId?: string,
    version?: number,
  ) {
    return this.db.transaction(() => {
      const e = this.expense(id),
        m = this.member(e.groupId, actor);
      const payer = e.payerId ?? payerId;
      ensure(
        m.role === "owner" ||
          actor === payer ||
          (action === "reject" && actor === e.createdBy),
        "FORBIDDEN",
        "Only the payer or group owner can confirm.",
        403,
      );
      if (e.status === (action === "confirm" ? "confirmed" : "rejected"))
        return e;
      ensure(
        e.status === "pending" && (!version || version === e.version),
        "STALE_EXPENSE",
        "Expense is no longer pending or was changed.",
        409,
      );
      if (action === "confirm") {
        ensure(payer, "PAYER_REQUIRED", "Who paid this receipt?");
        this.member(e.groupId, payer);
        ensure(
          this.pending(e.groupId).length === 0,
          "PLAN_ACTIVE",
          "Resolve or cancel the active settlement plan before confirming another expense.",
          409,
        );
      }
      this.db
        .update(s.expenses)
        .set({
          payerId: payer,
          status: action === "confirm" ? "confirmed" : "rejected",
          confirmedBy: actor,
          confirmedAt: Date.now(),
          version: e.version + 1,
        })
        .where(eq(s.expenses.id, id))
        .run();
      this.log(
        e.groupId,
        actor,
        `expense_${action === "confirm" ? "confirmed" : "rejected"}`,
        id,
      );
      if (action === "confirm" && this.isDirect(e.groupId)) {
        const group = this.db
          .select()
          .from(s.groups)
          .where(eq(s.groups.id, e.groupId))
          .get()!;
        const payerName = this.db
          .select()
          .from(s.users)
          .where(eq(s.users.id, payer!))
          .get()!.name;
        for (const share of this.db
          .select()
          .from(s.shares)
          .where(eq(s.shares.expenseId, id))
          .all()) {
          this.queue(
            e.groupId,
            `${group.name}: ${payerName} paid ${formatMoney(e.totalCents)} for ${e.description}. Your share: ${formatMoney(share.cents)}. Expense confirmed; no payment has been made. Text "use ${group.id.slice(0, 8)}", then "link" to review and choose how to settle. Text STOP to pause updates.`,
            share.userId,
          );
        }
      } else
        this.queue(
          e.groupId,
          action === "confirm"
            ? "Expense confirmed. The group balance is updated."
            : "Expense proposal rejected.",
        );
      return this.expense(id);
    });
  }
  revise(id: string, actor: string, description: string, totalCents: number) {
    return this.db.transaction(() => {
      const e = this.expense(id);
      const m = this.member(e.groupId, actor);
      ensure(
        e.status === "pending",
        "IMMUTABLE",
        "Confirmed expenses cannot be edited.",
        409,
      );
      ensure(
        actor === e.createdBy || actor === e.payerId || m.role === "owner",
        "FORBIDDEN",
        "Cannot edit this proposal.",
        403,
      );
      cents(totalCents);
      const people = this.db
        .select()
        .from(s.shares)
        .where(eq(s.shares.expenseId, id))
        .all()
        .map((sh) => sh.userId)
        .sort();
      this.db.delete(s.shares).where(eq(s.shares.expenseId, id)).run();
      this.db
        .insert(s.shares)
        .values(
          split(totalCents, people).map((sh) => ({ ...sh, expenseId: id })),
        )
        .run();
      this.db
        .update(s.expenses)
        .set({ description, totalCents, version: e.version + 1 })
        .where(eq(s.expenses.id, id))
        .run();
      this.log(e.groupId, actor, "expense_revised", id);
      return this.expense(id);
    });
  }
  plan(groupId: string, actor: string) {
    this.member(groupId, actor);
    return this.db.transaction(() => {
      const active = this.pending(groupId);
      if (active.length) return active;
      const planId = uid();
      const result = settle(this.balances(groupId));
      for (const [index, transfer] of result.entries())
        this.db
          .insert(s.intents)
          .values({
            id: uid(),
            ...transfer,
            groupId,
            expiresAt: Date.now() + 86_400_000,
            idempotencyKey: `${planId}:${index}`,
          })
          .run();
      this.log(groupId, actor, "settlement_plan_created", planId, {
        count: result.length,
      });
      if (this.isDirect(groupId)) {
        const group = this.db
          .select()
          .from(s.groups)
          .where(eq(s.groups.id, groupId))
          .get()!;
        for (const transfer of result) {
          const recipient = this.groupMembers(groupId).find(
            (m) => m.id === transfer.toId,
          )!;
          this.queue(
            groupId,
            `${group.name}: your settlement is ${formatMoney(transfer.amountCents)} to ${recipient.name}. Text "use ${groupId.slice(0, 8)}", then "link" to choose Solana devnet, Venmo, Apple Cash, Zelle or cash. No payment has been made.`,
            transfer.fromId,
          );
        }
      }
      return this.pending(groupId);
    });
  }
  cancelPlan(groupId: string, actor: string) {
    ensure(
      this.member(groupId, actor).role === "owner",
      "FORBIDDEN",
      "Only the owner can cancel a plan.",
      403,
    );
    return this.db.transaction(() => {
      const plan = this.pending(groupId);
      for (const i of plan) {
        const all = this.db
          .select()
          .from(s.attempts)
          .where(eq(s.attempts.intentId, i.id))
          .all();
        ensure(
          all.every((a) =>
            [
              "ready_for_external_payment",
              "awaiting_authorization",
              "failed",
              "expired",
              "cancelled",
            ].includes(a.status),
          ),
          "PAYMENT_IN_PROGRESS",
          "Claims, disputes or submitted payments must be resolved first.",
          409,
        );
      }
      for (const i of plan) {
        this.db
          .update(s.attempts)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(s.attempts.intentId, i.id),
              inArray(s.attempts.status, [
                "ready_for_external_payment",
                "awaiting_authorization",
              ]),
            ),
          )
          .run();
        this.db
          .update(s.intents)
          .set({ status: "cancelled" })
          .where(eq(s.intents.id, i.id))
          .run();
      }
      this.log(groupId, actor, "plan_cancelled", groupId);
      return { cancelled: plan.length };
    });
  }
  applyCredit(
    attemptId: string,
    actor: string | null,
    kind: "on_chain" | "recipient_confirmation",
  ) {
    // Internal provider callback only; API routes cannot supply a verification kind.
    return this.db.transaction(() => {
      const a = this.attempt(attemptId),
        i = this.intent(a.intentId);
      ensure(
        i.status === "pending" &&
          i.confirmedCents === 0 &&
          a.amountCents === i.amountCents,
        "ALREADY_RESOLVED",
        "Payment already resolved or amount mismatch.",
        409,
      );
      ensure(
        kind === "on_chain"
          ? a.status === "submitted" && !!a.signature
          : a.status === "sender_claimed" &&
              actor === i.toId &&
              actor !== i.fromId,
        "INVALID_TRANSITION",
        "Independent payment confirmation required.",
        403,
      );
      this.db
        .insert(s.credits)
        .values({
          attemptId,
          intentId: i.id,
          groupId: i.groupId,
          fromId: i.fromId,
          toId: i.toId,
          cents: a.amountCents,
          kind,
        })
        .run();
      this.db
        .update(s.attempts)
        .set({
          status:
            kind === "on_chain" ? "onchain_verified" : "recipient_confirmed",
          verifiedAt: kind === "on_chain" ? Date.now() : null,
          confirmedAt: kind === "recipient_confirmation" ? Date.now() : null,
        })
        .where(eq(s.attempts.id, a.id))
        .run();
      this.db
        .update(s.intents)
        .set({ status: "settled", confirmedCents: a.amountCents })
        .where(eq(s.intents.id, i.id))
        .run();
      this.log(
        i.groupId,
        actor,
        kind === "on_chain" ? "verified_on_chain" : "confirmed_by_recipient",
        a.id,
        { method: a.method },
      );
      const resolved = this.db
        .select()
        .from(s.intents)
        .where(
          and(
            eq(s.intents.groupId, i.groupId),
            eq(s.intents.status, "settled"),
          ),
        )
        .all().length;
      this.queue(
        i.groupId,
        `${resolved} of ${resolved + this.pending(i.groupId).length} settlements resolved.`,
      );
      return this.attempt(a.id);
    });
  }
}
