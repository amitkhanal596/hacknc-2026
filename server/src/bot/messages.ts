import type { Ctx } from "../context";
import { timings } from "../context";
import { flagBadges, listOf } from "../copy";
import type { Group } from "../db/schema";
import { groupDebts } from "../ledger/debts";
import { formatCents as $ } from "../ledger/money";
import { dm } from "../notify";
import { payLinkUrl } from "../payments/service";
import { setPrompt, clearPrompt } from "../store/dms";
import { pendingSharesFor, type ShareDetail } from "../store/expenses";
import { getUser, nameOf } from "../store/users";

/**
 * Sends one DM listing everything waiting on this person's OK, and remembers
 * the numbering so "YES 1 3" means what they saw. Returns how many are pending.
 */
export async function sendApprovalRequests(ctx: Ctx, userId: string, intro?: string): Promise<number> {
  const pending = pendingSharesFor(ctx, userId);
  if (pending.length === 0) {
    clearPrompt(ctx, userId, "approve");
    return 0;
  }
  setPrompt(ctx, userId, { kind: "approve", shareIds: pending.map((p) => p.share.id) }, timings(ctx.config).promptTtlMs);
  await dm(ctx, userId, approvalText(pending, intro));
  return pending.length;
}

export function approvalText(pending: ShareDetail[], intro?: string): string {
  const prefix = intro ? `${intro}\n` : "";
  if (pending.length === 1) {
    const d = pending[0]!;
    return (
      `${prefix}${nameOf(d.payer)} logged ${d.expense.description} ${$(d.expense.totalCents)} ` +
      `(${flagBadges(d.expense.flags, d.expense.receiptTotalCents)}) for ${d.group.name}. ` +
      `Your share: ${$(d.share.cents)}.\nReply YES, DISPUTE + reason, or WHY.`
    );
  }
  const lines = pending.map(
    (d, i) =>
      `${i + 1}) ${d.expense.description} ${$(d.expense.totalCents)} · your share ${$(d.share.cents)} · from ${nameOf(d.payer)} (${flagBadges(d.expense.flags, d.expense.receiptTotalCents)})`,
  );
  return `${prefix}You have ${pending.length} expenses waiting for your OK:\n${lines.join("\n")}\nReply YES ALL, YES 1 ${pending.length}, or DISPUTE 2 + reason.`;
}

/** The settle-up DM for one debtor: who they owe and both ways to pay. Undefined if they owe nothing. */
export function settleText(ctx: Ctx, group: Group, debtorId: string): string | undefined {
  const mine = groupDebts(ctx, group.id).filter((d) => d.fromId === debtorId);
  const pendingCount = pendingSharesFor(ctx, debtorId).filter((p) => p.group.id === group.id).length;
  if (mine.length === 0) return undefined;

  const owedList = listOf(mine.map((d) => `${nameOf(getUser(ctx, d.toId))} ${$(d.cents)}`));
  const lines = [`You owe ${owedList} for ${group.name}.`, "• Reply PAY to send USDC from your Tab wallet"];
  if (ctx.stripe) {
    if (mine.length === 1) {
      lines.push(`• Or pay with Apple Pay: ${payLinkUrl(ctx, group.id, debtorId, mine[0]!.toId)}`);
    } else {
      lines.push("• Or pay with Apple Pay:");
      for (const d of mine) lines.push(`   ${nameOf(getUser(ctx, d.toId))} ${$(d.cents)}: ${payLinkUrl(ctx, group.id, debtorId, d.toId)}`);
    }
  }
  lines.push("Reply WHY for the breakdown.");
  if (pendingCount > 0) {
    lines.push(`(${pendingCount} more expense${pendingCount > 1 ? "s are" : " is"} waiting on your OK and not counted yet.)`);
  }
  return lines.join("\n");
}
