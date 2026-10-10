/** All money in the app is integer cents. These helpers are the only place we convert. */

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** Parses "$80", "80.5", "1,200.00", "$12.3" into cents. Returns undefined if it isn't a number. */
export function parseDollarsToCents(input: string): number | undefined {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** USDC has 6 decimals: 1 cent = 10_000 base units. */
export function centsToTokenUnits(cents: number): bigint {
  return BigInt(cents) * 10_000n;
}
