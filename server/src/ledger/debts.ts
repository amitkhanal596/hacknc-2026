import type { Ctx } from "../context";
import { ledgerSharesForGroup } from "../store/expenses";
import { ledgerPaymentsForGroup, paymentsOf } from "../store/payments";
import { owed, pairwiseDebts, type Debt } from "./settle";

/** Current pairwise debts in a group (approved shares minus settled payments). */
export function groupDebts(ctx: Ctx, groupId: string): Debt[] {
  return pairwiseDebts(ledgerSharesForGroup(ctx, groupId), ledgerPaymentsForGroup(ctx, groupId));
}

/** An Apple Pay attempt still pending after this long was abandoned. */
export const STALE_PAYMENT_MS = 30 * 60 * 1000;

/**
 * The most `fromId` can pay `toId` right now: their approved debt minus any
 * payments still in flight, so a double "PAY" can't overpay. Abandoned Apple Pay
 * attempts stop counting after STALE_PAYMENT_MS.
 */
export function payableCents(ctx: Ctx, groupId: string, fromId: string, toId: string): number {
  const now = ctx.now();
  const inFlight = paymentsOf(ctx, groupId)
    .filter((p) => p.status === "pending" && p.fromId === fromId && p.toId === toId)
    .filter((p) => p.rail === "solana" || now - p.createdAt < STALE_PAYMENT_MS)
    .reduce((sum, p) => sum + p.cents, 0);
  return Math.max(0, owed(groupDebts(ctx, groupId), fromId, toId) - inFlight);
}
