import { ensure } from "./money";
export type Balance = { userId: string; cents: number };
export function settle(balances: Balance[]) {
  ensure(
    new Set(balances.map((b) => b.userId)).size === balances.length &&
      balances.every((b) => Number.isSafeInteger(b.cents)) &&
      balances.reduce((a, b) => a + b.cents, 0) === 0,
    "UNBALANCED_LEDGER",
    "Balances must conserve value.",
  );
  const debtors = balances
    .filter((b) => b.cents < 0)
    .map((b) => ({ ...b, cents: -b.cents }))
    .sort((a, b) => b.cents - a.cents || a.userId.localeCompare(b.userId));
  const creditors = balances
    .filter((b) => b.cents > 0)
    .map((b) => ({ ...b }))
    .sort((a, b) => b.cents - a.cents || a.userId.localeCompare(b.userId));
  const transfers: { fromId: string; toId: string; amountCents: number }[] = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!,
      c = creditors[j]!;
    const amountCents = Math.min(d.cents, c.cents);
    transfers.push({ fromId: d.userId, toId: c.userId, amountCents });
    d.cents -= amountCents;
    c.cents -= amountCents;
    if (!d.cents) i++;
    if (!c.cents) j++;
  }
  return transfers;
}
