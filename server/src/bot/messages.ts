import type { Ctx } from "../context";
import { timings } from "../context";
import { flagBadges, listOf } from "../copy";
import type { Group } from "../db/schema";
import { groupDebts } from "../ledger/debts";
import { formatCents as $ } from "../ledger/money";
import { netBalances } from "../ledger/settle";
import { dm } from "../notify";
import { payLinkUrl } from "../payments/service";
import { setPrompt } from "../store/dms";
import type { ShareDetail } from "../store/expenses";
import { getUser, nameOf } from "../store/users";

/** "you owe $46.66" / "you're owed $12.00" / "you're all even": the person's net position in the group. */
export function runningTotal(ctx: Ctx, groupId: string, userId: string): string {
  const net = netBalances(groupDebts(ctx, groupId)).get(userId) ?? 0;
  if (net < 0) return `you owe ${$(-net)}`;
  if (net > 0) return `you're owed ${$(net)}`;
  return "you're all even";
}

/** Shared tail for expense heads-ups: how to push back without sounding formal. */
export const NOT_RIGHT_HINT = `Not right? Reply NOPE and what's off (like "nope, I didn't eat").`;

/**
 * Heads-up that an expense was logged with their share and running total.
 * Nothing to approve: the share already counts unless they reply NOPE.
 * Remembers which share this was so a bare "nope, ..." flags the right one.
 */
export async function sendExpenseNotice(ctx: Ctx, d: ShareDetail, intro?: string): Promise<void> {
  setPrompt(ctx, d.share.userId, { kind: "notice", shareId: d.share.id }, timings(ctx.config).promptTtlMs);
  const head = intro ?? `${nameOf(d.payer)} logged ${d.expense.description} ${$(d.expense.totalCents)} (${flagBadges(d.expense.flags, d.expense.receiptTotalCents)}) for ${d.group.name}.`;
  await dm(
    ctx,
    d.share.userId,
    `${head}\nYour share: ${$(d.share.cents)} · Running total: ${runningTotal(ctx, d.group.id, d.share.userId)}.\n${NOT_RIGHT_HINT}`,
  );
}

/** The settle-up DM for one debtor: who they owe and both ways to pay. Undefined if they owe nothing. */
export function settleText(ctx: Ctx, group: Group, debtorId: string): string | undefined {
  const mine = groupDebts(ctx, group.id).filter((d) => d.fromId === debtorId);
  if (mine.length === 0) return undefined;

  const owedList = listOf(mine.map((d) => `${nameOf(getUser(ctx, d.toId))} ${$(d.cents)}`));
  const lines = [`Time to settle up ${group.name}: you owe ${owedList}.`, "• Reply PAY to send USDC from your Tab wallet"];
  if (ctx.stripe) {
    if (mine.length === 1) {
      lines.push(`• Or pay with Apple Pay: ${payLinkUrl(ctx, group.id, debtorId, mine[0]!.toId)}`);
    } else {
      lines.push("• Or pay with Apple Pay:");
      for (const d of mine) lines.push(`   ${nameOf(getUser(ctx, d.toId))} ${$(d.cents)}: ${payLinkUrl(ctx, group.id, debtorId, d.toId)}`);
    }
  }
  lines.push("Reply WHY for the breakdown.");
  return lines.join("\n");
}
