import type { PaymentStatus, ShareStatus } from "../db/schema";

export interface LedgerShare {
  payerId: string;
  userId: string;
  cents: number;
  status: ShareStatus;
}

export interface LedgerPayment {
  fromId: string;
  toId: string;
  cents: number;
  status: PaymentStatus;
}

export interface Debt {
  fromId: string;
  toId: string;
  cents: number;
}

/** A held Apple Pay payment is already paid from the debtor's side, so it counts. */
const SETTLED_PAYMENT: ReadonlySet<PaymentStatus> = new Set(["confirmed", "held", "released"]);

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Pairwise debts: what each person owes each other person, netted in both
 * directions and reduced by payments. Only approved shares count.
 *
 * We use pairwise debts (not cross-person simplification) as the source of
 * truth because they map directly to "why do I owe Amit?". Every dollar
 * traces back to that person's expenses.
 */
export function pairwiseDebts(shares: LedgerShare[], payments: LedgerPayment[]): Debt[] {
  // balance[pairKey] is positive when the lexicographically smaller id owes the larger one.
  const balance = new Map<string, number>();
  const add = (debtor: string, creditor: string, cents: number) => {
    if (debtor === creditor || cents === 0) return;
    const key = pairKey(debtor, creditor);
    const sign = debtor < creditor ? 1 : -1;
    balance.set(key, (balance.get(key) ?? 0) + sign * cents);
  };

  for (const s of shares) {
    if (s.status === "approved") add(s.userId, s.payerId, s.cents);
  }
  for (const p of payments) {
    if (SETTLED_PAYMENT.has(p.status)) add(p.fromId, p.toId, -p.cents);
  }

  const debts: Debt[] = [];
  for (const [key, cents] of balance) {
    if (cents === 0) continue;
    const [a, b] = key.split("|") as [string, string];
    debts.push(cents > 0 ? { fromId: a, toId: b, cents } : { fromId: b, toId: a, cents: -cents });
  }
  return debts.sort((x, y) => y.cents - x.cents);
}

/** Net position per person: positive means they're owed money. Always sums to zero. */
export function netBalances(debts: Debt[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const d of debts) {
    net.set(d.fromId, (net.get(d.fromId) ?? 0) - d.cents);
    net.set(d.toId, (net.get(d.toId) ?? 0) + d.cents);
  }
  return net;
}

/**
 * Fewest-transfers settlement (greedy: largest debtor pays largest creditor).
 * Produces at most n-1 transfers. Not the default, because it can route money
 * between people who never shared an expense. Kept for a future "simplify debts"
 * setting.
 */
export function simplify(net: Map<string, number>): Debt[] {
  const creditors = [...net].filter(([, c]) => c > 0).map(([id, c]) => ({ id, c }));
  const debtors = [...net].filter(([, c]) => c < 0).map(([id, c]) => ({ id, c: -c }));
  creditors.sort((a, b) => b.c - a.c || a.id.localeCompare(b.id));
  debtors.sort((a, b) => b.c - a.c || a.id.localeCompare(b.id));
  const out: Debt[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!;
    const c = creditors[j]!;
    const amount = Math.min(d.c, c.c);
    out.push({ fromId: d.id, toId: c.id, cents: amount });
    d.c -= amount;
    c.c -= amount;
    if (d.c === 0) i++;
    if (c.c === 0) j++;
  }
  return out;
}

export function owed(debts: Debt[], fromId: string, toId: string): number {
  return debts.find((d) => d.fromId === fromId && d.toId === toId)?.cents ?? 0;
}
