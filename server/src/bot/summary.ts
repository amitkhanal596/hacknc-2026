import type { Ctx } from "../context";
import type { ExpenseFlag, Group, User } from "../db/schema";
import { formatCents as $ } from "../ledger/money";
import { expensesOf, sharesOf } from "../store/expenses";
import { membersOf } from "../store/groups";
import { paymentsOf } from "../store/payments";
import { nameOf } from "../store/users";

/** One other person in the group, and how your debts with them net out. */
export interface PersonLine {
  id: string;
  name: string;
  /** Your counted shares on their expenses. */
  youOwedThem: number;
  /** Their counted shares on your expenses. */
  theyOwedYou: number;
  paidThem: number;
  paidYou: number;
  /** Positive: they owe you. Negative: you owe them. Same math as settle-up. */
  net: number;
}

export interface ExpenseLine {
  id: string;
  description: string;
  totalCents: number;
  payerName: string;
  youPaid: boolean;
  /** Your share, or null if you're not in this one. */
  yourShare: number | null;
  status: "counted" | "flagged" | "not in it";
  flags: ExpenseFlag[];
  hasReceipt: boolean;
  createdAt: number;
  today: boolean;
}

export interface TabSummary {
  group: Group;
  user: User;
  /** Positive: you're owed overall. Negative: you owe overall. */
  net: number;
  paidCents: number;
  yourShareCents: number;
  people: PersonLine[];
  expenses: ExpenseLine[];
  flaggedCount: number;
}

const SETTLED = new Set(["confirmed", "held", "released"]);

export function buildSummary(ctx: Ctx, user: User, group: Group): TabSummary {
  const members = membersOf(ctx, group.id);
  const others = members.filter((m) => m.id !== user.id);
  const people = new Map<string, PersonLine>(
    others.map((m) => [m.id, { id: m.id, name: nameOf(m), youOwedThem: 0, theyOwedYou: 0, paidThem: 0, paidYou: 0, net: 0 }]),
  );
  const nameById = new Map(members.map((m) => [m.id, nameOf(m)]));
  const startOfToday = new Date(ctx.now()).setHours(0, 0, 0, 0);

  let paidCents = 0;
  let yourShareCents = 0;
  let flaggedCount = 0;
  const expenses: ExpenseLine[] = [];

  for (const e of expensesOf(ctx, group.id)) {
    if (e.status !== "active") continue;
    const shares = sharesOf(ctx, e.id);
    const mine = shares.find((s) => s.userId === user.id && s.status !== "rejected");
    const youPaid = e.payerId === user.id;
    if (youPaid) paidCents += e.totalCents;
    if (mine?.status === "approved") yourShareCents += mine.cents;
    if (mine?.status === "disputed") flaggedCount++;

    for (const s of shares) {
      if (s.status !== "approved") continue;
      if (s.userId === user.id && !youPaid) people.get(e.payerId)!.youOwedThem += s.cents;
      if (youPaid && s.userId !== user.id) people.get(s.userId)!.theyOwedYou += s.cents;
    }

    expenses.push({
      id: e.id,
      description: e.description,
      totalCents: e.totalCents,
      payerName: youPaid ? "You" : nameById.get(e.payerId) ?? "someone",
      youPaid,
      yourShare: mine ? mine.cents : null,
      status: !mine ? "not in it" : mine.status === "disputed" ? "flagged" : "counted",
      flags: e.flags,
      hasReceipt: !!(e.receiptHash || e.receiptTotalCents),
      createdAt: e.createdAt,
      today: e.createdAt >= startOfToday,
    });
  }

  for (const p of paymentsOf(ctx, group.id)) {
    if (!SETTLED.has(p.status)) continue;
    if (p.fromId === user.id && people.has(p.toId)) people.get(p.toId)!.paidThem += p.cents;
    if (p.toId === user.id && people.has(p.fromId)) people.get(p.fromId)!.paidYou += p.cents;
  }
  for (const p of people.values()) p.net = p.theyOwedYou - p.paidYou - (p.youOwedThem - p.paidThem);

  const lines = [...people.values()].filter((p) => p.youOwedThem || p.theyOwedYou || p.paidThem || p.paidYou);
  lines.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  return { group, user, net: lines.reduce((sum, p) => sum + p.net, 0), paidCents, yourShareCents, people: lines, expenses, flaggedCount };
}

export function netPhrase(net: number): string {
  if (net > 0) return `you're owed ${$(net)}`;
  if (net < 0) return `you owe ${$(-net)}`;
  return "you're all even";
}

/** "Priya owed you $25, you owed her $20 → she pays you $5". Shows the netting when it happened. */
export function personPhrase(p: PersonLine): string {
  const result = p.net > 0 ? `${p.name} owes you ${$(p.net)}` : p.net < 0 ? `you owe ${p.name} ${$(-p.net)}` : `you and ${p.name} are even`;
  const paid = p.paidThem ? ` (after your ${$(p.paidThem)} payment)` : p.paidYou ? ` (after their ${$(p.paidYou)} payment)` : "";
  if (p.youOwedThem && p.theyOwedYou) {
    return `${p.name}: you owed ${$(p.youOwedThem)}, they owed you ${$(p.theyOwedYou)} → ${result}${paid}`;
  }
  return `${result.charAt(0).toUpperCase()}${result.slice(1)}${paid}`;
}

/** The short text reply. The rich link card that follows carries the full picture. */
export function summaryText(s: TabSummary): string {
  const lines = [`Your ${s.group.name} tab: ${netPhrase(s.net)}.`];
  for (const p of s.people.slice(0, 4)) lines.push(`• ${personPhrase(p)}`);
  const today = s.expenses.filter((e) => e.today && e.yourShare !== null);
  if (today.length) {
    const items = today.slice(0, 4).map((e) => `${e.description} ${$(e.yourShare!)}${e.status === "flagged" ? " (on hold)" : ""}`);
    lines.push(`Today: ${items.join(", ")}${today.length > 4 ? `, +${today.length - 4} more` : ""}.`);
  }
  lines.push(`You've paid ${$(s.paidCents)} so far · your share of everything is ${$(s.yourShareCents)}.`);
  if (s.flaggedCount) lines.push(`${s.flaggedCount} expense${s.flaggedCount > 1 ? "s are" : " is"} on hold while you sort it out.`);
  return lines.join("\n");
}
