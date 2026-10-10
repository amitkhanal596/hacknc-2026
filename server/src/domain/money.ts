export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
export const MAX_CENTS = 1_000_000;
export function cents(n: number): number {
  ensure(
    Number.isSafeInteger(n) && n > 0 && n <= MAX_CENTS,
    "INVALID_AMOUNT",
    "Amount must be positive integer cents, at most $10,000.",
  );
  return n;
}
export function parseDollars(s: string): number {
  ensure(
    /^\d+(\.\d{1,2})?$/.test(s),
    "INVALID_AMOUNT",
    "Use a USD amount with at most two decimal places.",
  );
  const [whole, fraction = ""] = s.split(".");
  return cents(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
}
export function formatMoney(n: number): string {
  ensure(Number.isSafeInteger(n), "INVALID_AMOUNT", "Invalid cents.");
  return `${n < 0 ? "-" : ""}$${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, "0")}`;
}
export function tokenUnits(n: number): bigint {
  return BigInt(cents(n)) * 10_000n;
}
