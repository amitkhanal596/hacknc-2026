import type { ApprovedVia, ExpenseShare, ShareStatus } from "../db/schema";

export const AUTO_APPROVE_MS = 24 * 60 * 60 * 1000;

export type ShareAction =
  | { type: "approve"; actorId: string; via: Exclude<ApprovedVia, "auto" | "payer"> }
  | { type: "dispute"; actorId: string; reason: string }
  | { type: "auto_approve" }
  | { type: "reset" } // the expense was edited
  | { type: "reject" }; // the payer withdrew the expense

export type SharePatch = Partial<Pick<ExpenseShare, "status" | "approvedVia" | "decidedAt" | "disputeReason">>;

export type TransitionResult = { ok: true; patch: SharePatch } | { ok: false; error: TransitionError };

export type TransitionError = "not_owner" | "not_pending" | "not_due" | "no_receipt" | "already_final";

type ShareState = Pick<ExpenseShare, "userId" | "status" | "autoApproveAt" | "approvedVia">;

/**
 * The share state machine (see ARCHITECTURE.md). Pure: returns the change to
 * apply, or why it isn't allowed. The key rule: only the share's owner can
 * approve or dispute it.
 */
export function transition(share: ShareState, action: ShareAction, now: number): TransitionResult {
  if (share.status === "rejected") return { ok: false, error: "already_final" };

  switch (action.type) {
    case "approve":
      if (action.actorId !== share.userId) return { ok: false, error: "not_owner" };
      if (share.status === "approved") return { ok: false, error: "not_pending" };
      return { ok: true, patch: { status: "approved", approvedVia: action.via, decidedAt: now, disputeReason: null } };

    case "dispute":
      if (action.actorId !== share.userId) return { ok: false, error: "not_owner" };
      if (share.approvedVia === "payer") return { ok: false, error: "not_pending" };
      return { ok: true, patch: { status: "disputed", disputeReason: action.reason, decidedAt: now, approvedVia: null } };

    case "auto_approve":
      if (share.status !== "pending") return { ok: false, error: "not_pending" };
      if (share.autoApproveAt === null) return { ok: false, error: "no_receipt" };
      if (now < share.autoApproveAt) return { ok: false, error: "not_due" };
      return { ok: true, patch: { status: "approved", approvedVia: "auto", decidedAt: now } };

    case "reset":
      if (share.approvedVia === "payer") return { ok: false, error: "not_pending" };
      return { ok: true, patch: { status: "pending", approvedVia: null, decidedAt: null, disputeReason: null } };

    case "reject":
      return { ok: true, patch: { status: "rejected", decidedAt: now } };
  }
}

/** Initial state for a new share. The payer's own share is approved automatically. */
export function initialShare(opts: {
  userId: string;
  payerId: string;
  hasReceipt: boolean;
  now: number;
  autoApproveMs?: number;
}): {
  status: ShareStatus;
  approvedVia: ApprovedVia | null;
  decidedAt: number | null;
  autoApproveAt: number | null;
} {
  if (opts.userId === opts.payerId) {
    return { status: "approved", approvedVia: "payer", decidedAt: opts.now, autoApproveAt: null };
  }
  return {
    status: "pending",
    approvedVia: null,
    decidedAt: null,
    // Shares with no receipt never auto-approve; the person has to say yes.
    autoApproveAt: opts.hasReceipt ? opts.now + (opts.autoApproveMs ?? AUTO_APPROVE_MS) : null,
  };
}
