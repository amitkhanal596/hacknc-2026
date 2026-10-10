export interface ShareAmount {
  userId: string;
  cents: number;
}

/**
 * Splits a total evenly so the shares always add up to exactly the total.
 * Leftover cents go to `remainderTo` (the payer, so everyone else pays the
 * same), or one each to the first participants if it isn't given.
 */
export function splitEqual(totalCents: number, participantIds: string[], remainderTo?: string): ShareAmount[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new Error("total must be a positive integer number of cents");
  const ids = [...new Set(participantIds)];
  if (ids.length === 0) throw new Error("need at least one participant");
  const base = Math.floor(totalCents / ids.length);
  const remainder = totalCents - base * ids.length;
  if (remainderTo && ids.includes(remainderTo)) {
    return ids.map((userId) => ({ userId, cents: base + (userId === remainderTo ? remainder : 0) }));
  }
  return ids.map((userId, i) => ({ userId, cents: base + (i < remainder ? 1 : 0) }));
}

/** Validates explicit per-person amounts. They must be non-negative and add up to the total. */
export function splitCustom(totalCents: number, shares: ShareAmount[]): ShareAmount[] {
  const seen = new Set<string>();
  let sum = 0;
  for (const s of shares) {
    if (seen.has(s.userId)) throw new Error(`duplicate participant ${s.userId}`);
    if (!Number.isInteger(s.cents) || s.cents < 0) throw new Error("share amounts must be non-negative integer cents");
    seen.add(s.userId);
    sum += s.cents;
  }
  if (sum !== totalCents) throw new Error(`shares add up to ${sum}, expected ${totalCents}`);
  return shares.filter((s) => s.cents > 0);
}
