import { cents, ensure } from "./money";
export type Share = { userId: string; cents: number };
export function split(
  total: number,
  participants: string[],
  weights?: number[],
): Share[] {
  cents(total);
  ensure(
    participants.length > 0 &&
      participants.length <= 100 &&
      new Set(participants).size === participants.length &&
      participants.every(Boolean),
    "INVALID_PARTICIPANTS",
    "Choose unique participants.",
  );
  const w = weights ?? participants.map(() => 1);
  ensure(
    w.length === participants.length &&
      w.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000),
    "INVALID_WEIGHTS",
    "Weights must be positive integers.",
  );
  const sum = w.reduce((a, b) => a + BigInt(b), 0n);
  const amounts = w.map((n) => Number((BigInt(total) * BigInt(n)) / sum));
  let remainder = total - amounts.reduce((a, b) => a + b, 0);
  const order = w
    .map((n, i) => ({ i, r: (BigInt(total) * BigInt(n)) % sum }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (remainder-- <= 0) break;
    amounts[i] = amounts[i]! + 1;
  }
  return participants.map((userId, i) => ({ userId, cents: amounts[i]! }));
}
export function customShares(total: number, shares: Share[]): Share[] {
  cents(total);
  ensure(
    shares.length > 0 &&
      new Set(shares.map((s) => s.userId)).size === shares.length &&
      shares.every(
        (s) => s.userId && Number.isSafeInteger(s.cents) && s.cents >= 0,
      ) &&
      shares.reduce((a, s) => a + s.cents, 0) === total,
    "INVALID_SHARES",
    "Shares must sum exactly to the total.",
  );
  return shares;
}
