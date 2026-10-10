import type { Ctx } from "../context";
import { flagBadges, railLabel, shortDate } from "../copy";
import type { Group, User } from "../db/schema";
import { groupDebts } from "../ledger/debts";
import { formatCents as $ } from "../ledger/money";
import { owed } from "../ledger/settle";
import { sharesOf, userSharesInGroup, type ShareDetail } from "../store/expenses";
import { membersOf } from "../store/groups";
import { paymentsOf } from "../store/payments";
import { getUser, nameOf } from "../store/users";
import { getDM } from "../store/dms";

/**
 * "Why do I owe this?" Built only from ledger records: no LLM, so it can't
 * invent anything. Every line points at a real expense, receipt, approval, or
 * payment.
 */
export function explain(ctx: Ctx, user: User, group: Group, counterpartyId?: string): string {
  const debts = groupDebts(ctx, group.id);
  const others = membersOf(ctx, group.id).filter((m) => m.id !== user.id && (!counterpartyId || m.id === counterpartyId));
  const sections = others.map((other) => sectionFor(ctx, user, other, group, owed(debts, user.id, other.id) - owed(debts, other.id, user.id)));
  const relevant = sections.filter((s): s is string => !!s);

  if (relevant.length === 0) {
    return counterpartyId
      ? `You and ${nameOf(getUser(ctx, counterpartyId))} are even in ${group.name}. Nothing's owed either way.`
      : `You're all settled up in ${group.name}. Nothing's owed either way.`;
  }
  return relevant.join("\n\n");
}

const MAX_LINES = 8;

function sectionFor(ctx: Ctx, user: User, other: User, group: Group, net: number): string | undefined {
  const lines: string[] = [];

  // What the user owes `other`: the user's shares on other's expenses.
  for (const d of userSharesInGroup(ctx, user.id, group.id).filter((d) => d.payer.id === other.id)) {
    if (d.share.status === "rejected") continue;
    lines.push(`• ${$(d.share.cents)} ${d.expense.description} ${math(ctx, d)} · ${source(ctx, d)} · ${status(d, "you")}`);
  }
  // What `other` owes the user: their shares on the user's expenses (these reduce what the user owes).
  for (const d of userSharesInGroup(ctx, other.id, group.id).filter((d) => d.payer.id === user.id)) {
    if (d.share.status !== "approved") continue;
    lines.push(`• −${$(d.share.cents)} ${nameOf(other)}'s share of ${d.expense.description} (you paid)`);
  }
  for (const p of paymentsOf(ctx, group.id)) {
    if (!["confirmed", "held", "released"].includes(p.status)) continue;
    if (p.fromId === user.id && p.toId === other.id) lines.push(`• −${$(p.cents)} you paid ${shortDate(p.createdAt)} (${railLabel(p)})`);
    if (p.fromId === other.id && p.toId === user.id) lines.push(`• +${$(p.cents)} ${nameOf(other)} paid you ${shortDate(p.createdAt)} (${railLabel(p)})`);
  }

  if (lines.length === 0) return undefined;
  const header =
    net > 0
      ? `You owe ${nameOf(other)} ${$(net)} for ${group.name}:`
      : net < 0
        ? `${nameOf(other)} owes you ${$(-net)} for ${group.name}:`
        : `Nothing owed with ${nameOf(other)} yet in ${group.name}:`;
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`• …and ${lines.length - MAX_LINES} more (see the Tab extension for everything)`);
  return [header, ...shown].join("\n");
}

function math(ctx: Ctx, d: ShareDetail): string {
  const n = sharesOf(ctx, d.expense.id).filter((s) => s.status !== "rejected").length;
  const even = d.share.cents === Math.floor(d.expense.totalCents / n) || Math.abs(d.share.cents - d.expense.totalCents / n) < 1;
  return even ? `(${$(d.expense.totalCents)} ÷ ${n})` : `(your part of ${$(d.expense.totalCents)})`;
}

function source(ctx: Ctx, d: ShareDetail): string {
  const payer = nameOf(d.payer);
  const date = shortDate(d.expense.createdAt);
  if (d.expense.receiptHash || d.expense.receiptTotalCents) {
    const merchant = d.expense.merchant ? ` (${d.expense.merchant})` : "";
    return `${payer}'s receipt${merchant}, ${date} · ${flagBadges(d.expense.flags, d.expense.receiptTotalCents)}`;
  }
  const original = d.expense.sourceText ?? (d.expense.sourceDmId ? getDM(ctx, d.expense.sourceDmId)?.text : undefined);
  const quote = original ? `${payer} texted "${truncate(original, 50)}"` : `logged by ${payer}`;
  return `${quote}, ${date} · ⚠️ no receipt`;
}

function status(d: ShareDetail, you: string): string {
  const s = d.share;
  switch (s.status) {
    case "approved":
      return s.approvedVia === "auto"
        ? `auto-approved ${shortDate(s.decidedAt ?? d.expense.createdAt)} (had a receipt)`
        : `${you} approved ${shortDate(s.decidedAt ?? d.expense.createdAt)}`;
    case "pending":
      return "waiting on your OK (not counted yet)";
    case "disputed":
      return `you disputed it${s.disputeReason ? `: "${truncate(s.disputeReason, 40)}"` : ""} (not counted)`;
    default:
      return s.status;
  }
}

function truncate(s: string, n: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
