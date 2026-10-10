import { and, eq, lt } from "drizzle-orm";
import { sendApprovalRequests, settleText } from "../bot/messages";
import type { Ctx } from "../context";
import { timings } from "../context";
import { groups, payments, reminders } from "../db/schema";
import { groupDebts, STALE_PAYMENT_MS } from "../ledger/debts";
import { formatCents as $ } from "../ledger/money";
import { dm } from "../notify";
import { refreshPayoutStatus, releaseHeldPayments } from "../payments/service";
import { applyShareAction, dueAutoApprovals, pendingSharesFor, shareDetail } from "../store/expenses";
import { membersOf } from "../store/groups";
import { getUser, nameOf } from "../store/users";

/** Approves receipt-backed shares nobody responded to in time, and tells the owner. */
export async function autoApprove(ctx: Ctx): Promise<number> {
  let count = 0;
  for (const share of dueAutoApprovals(ctx)) {
    const r = applyShareAction(ctx, share.id, { type: "auto_approve" });
    if (!r.ok) continue;
    count++;
    const d = shareDetail(ctx, share.id);
    if (d) {
      await dm(
        ctx,
        share.userId,
        `Auto-approved your ${$(share.cents)} share of ${d.expense.description} (${nameOf(d.payer)} had a receipt and I didn't hear back). Reply DISPUTE <reason> if that's wrong.`,
      );
    }
  }
  return count;
}

/**
 * Reminders with exponential backoff. The first time we notice something
 * (a debt or a pending share), we just start the clock. After one interval we
 * remind, then wait 2x, 4x, ... between reminders. Once it's resolved, the
 * clock is cleared.
 */
export async function sendReminders(ctx: Ctx): Promise<number> {
  const interval = timings(ctx.config).reminderMs;
  const now = ctx.now();
  let sent = 0;

  const due = (userId: string, groupId: string, kind: "debt" | "review") => {
    const row = ctx.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.groupId, groupId), eq(reminders.kind, kind)))
      .get();
    if (!row) {
      ctx.db.insert(reminders).values({ userId, groupId, kind, lastSentAt: now, count: 0 }).run();
      return false;
    }
    if (now - row.lastSentAt < interval * 2 ** row.count) return false;
    ctx.db
      .update(reminders)
      .set({ lastSentAt: now, count: Math.min(row.count + 1, 6) })
      .where(and(eq(reminders.userId, userId), eq(reminders.groupId, groupId), eq(reminders.kind, kind)))
      .run();
    return true;
  };
  const clear = (userId: string, groupId: string, kind: "debt" | "review") =>
    ctx.db.delete(reminders).where(and(eq(reminders.userId, userId), eq(reminders.groupId, groupId), eq(reminders.kind, kind))).run();

  for (const group of ctx.db.select().from(groups).all()) {
    const debtors = new Set(groupDebts(ctx, group.id).map((d) => d.fromId));
    for (const member of membersOf(ctx, group.id)) {
      // Unpaid approved balances.
      if (debtors.has(member.id)) {
        if (due(member.id, group.id, "debt")) {
          const text = settleText(ctx, group, member.id);
          if (text) {
            await dm(ctx, member.id, `⏰ Reminder: ${text}`);
            sent++;
          }
        }
      } else clear(member.id, group.id, "debt");

      // Shares waiting on their OK.
      const pending = pendingSharesFor(ctx, member.id).filter((p) => p.group.id === group.id);
      if (pending.length > 0) {
        if (due(member.id, group.id, "review")) {
          await sendApprovalRequests(ctx, member.id, "⏰ Reminder:");
          sent++;
        }
      } else clear(member.id, group.id, "review");
    }
  }
  return sent;
}

/**
 * Backup for the account webhook (handy when webhooks aren't forwarded during a
 * demo): re-checks creditors with held money. refreshPayoutStatus releases it
 * the first time an account becomes ready; already-ready accounts get a retry.
 */
export async function sweepHeldPayments(ctx: Ctx): Promise<number> {
  if (!ctx.stripe) return 0;
  const creditorIds = new Set(
    ctx.db.select({ toId: payments.toId }).from(payments).where(eq(payments.status, "held")).all().map((r) => r.toId),
  );
  let released = 0;
  for (const creditorId of creditorIds) {
    try {
      const wasReady = !!getUser(ctx, creditorId)?.stripePayoutsEnabled;
      const ready = await refreshPayoutStatus(ctx, creditorId);
      if (ready && wasReady) released += await releaseHeldPayments(ctx, creditorId);
    } catch (err) {
      console.warn(`[stripe] couldn't check creditor ${creditorId}:`, (err as Error).message);
    }
  }
  return released;
}

/** Apple Pay attempts that never completed stop counting as "in flight" and are marked failed. */
export function expireStalePayments(ctx: Ctx): number {
  const cutoff = ctx.now() - STALE_PAYMENT_MS;
  return ctx.db
    .update(payments)
    .set({ status: "failed" })
    .where(and(eq(payments.status, "pending"), eq(payments.rail, "apple_pay"), lt(payments.createdAt, cutoff)))
    .run().changes;
}

export async function runJobs(ctx: Ctx) {
  const approved = await autoApprove(ctx);
  const reminded = await sendReminders(ctx);
  const released = await sweepHeldPayments(ctx);
  const expired = expireStalePayments(ctx);
  return { approved, reminded, released, expired };
}

/** Runs all jobs on a timer. Returns a function that stops them. */
export function startJobs(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runJobs(ctx);
    } catch (err) {
      console.error("[jobs] tick failed", err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, timings(ctx.config).jobTickMs);
  return () => clearInterval(handle);
}
