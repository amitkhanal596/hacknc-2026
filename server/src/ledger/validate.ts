import type { ExpenseFlag } from "../db/schema";

export interface ReceiptInfo {
  totalCents?: number;
  hash?: string;
  merchant?: string;
  date?: string; // YYYY-MM-DD
}

export interface ExpenseCandidate {
  reason?: string;
  totalCents?: number; // what the person claimed; falls back to the receipt total
  receipt?: ReceiptInfo;
}

export interface PriorExpense {
  receiptHash: string | null;
  merchant: string | null;
  receiptTotalCents: number | null;
  receiptDate: string | null;
}

export type ValidationResult =
  | { ok: true; totalCents: number; flags: ExpenseFlag[] }
  | { ok: false; problem: "missing_reason" | "missing_amount" };

/** A claim can differ from the receipt by the larger of $1 or 5% (covers tip rounding) before it's flagged. */
export function mismatchTolerance(receiptTotalCents: number): number {
  return Math.max(100, Math.round(receiptTotalCents * 0.05));
}

export function validateExpense(candidate: ExpenseCandidate, history: PriorExpense[]): ValidationResult {
  const receipt = candidate.receipt;
  const hasReceipt = !!receipt && (receipt.totalCents !== undefined || !!receipt.hash);
  const reason = candidate.reason?.trim() || receipt?.merchant?.trim();
  if (!reason) return { ok: false, problem: "missing_reason" };

  const totalCents = candidate.totalCents ?? receipt?.totalCents;
  if (!totalCents || totalCents <= 0) return { ok: false, problem: "missing_amount" };

  const flags: ExpenseFlag[] = [];
  if (!hasReceipt) flags.push("no_receipt");

  if (receipt?.totalCents !== undefined && candidate.totalCents !== undefined) {
    if (Math.abs(candidate.totalCents - receipt.totalCents) > mismatchTolerance(receipt.totalCents)) {
      flags.push("amount_mismatch");
    }
  }

  if (receipt && isDuplicate(receipt, history)) flags.push("possible_duplicate");

  return { ok: true, totalCents, flags };
}

function isDuplicate(receipt: ReceiptInfo, history: PriorExpense[]): boolean {
  return history.some((h) => {
    if (receipt.hash && h.receiptHash === receipt.hash) return true;
    return (
      !!receipt.merchant &&
      !!h.merchant &&
      receipt.merchant.trim().toLowerCase() === h.merchant.trim().toLowerCase() &&
      receipt.totalCents !== undefined &&
      receipt.totalCents === h.receiptTotalCents &&
      !!receipt.date &&
      receipt.date === h.receiptDate
    );
  });
}
