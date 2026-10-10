import { and, asc, desc, eq, inArray, isNotNull, lte, ne } from "drizzle-orm";
import type { Ctx } from "../context";
import { timings } from "../context";
import {
  auditLog,
  expenseShares,
  expenses,
  groups,
  users,
  type AuditAction,
  type Expense,
  type ExpenseFlag,
  type ExpenseShare,
  type Group,
  type User,
} from "../db/schema";
import { newId } from "../ids";
import { initialShare, transition, type ShareAction, type TransitionError } from "../ledger/approvals";
import type { LedgerShare } from "../ledger/settle";
import type { ShareAmount } from "../ledger/splits";
import type { PriorExpense, ReceiptInfo } from "../ledger/validate";

export function audit(
  ctx: Ctx,
  entry: { expenseId?: string; paymentId?: string; actorId?: string | null; action: AuditAction; detail?: string },
) {
  ctx.db
    .insert(auditLog)
    .values({
      id: newId("aud"),
      expenseId: entry.expenseId ?? null,
      paymentId: entry.paymentId ?? null,
      actorId: entry.actorId ?? null,
      action: entry.action,
      detail: entry.detail ?? null,
      at: ctx.now(),
    })
    .run();
}

export function auditForExpense(ctx: Ctx, expenseId: string) {
  return ctx.db.select().from(auditLog).where(eq(auditLog.expenseId, expenseId)).orderBy(asc(auditLog.at)).all();
}

export interface NewExpense {
  groupId: string;
  payerId: string;
  description: string;
  totalCents: number;
  shares: ShareAmount[];
  flags: ExpenseFlag[];
  receipt?: ReceiptInfo & { url?: string };
  sourceDmId?: string;
  sourceText?: string | null;
}

export function createExpense(ctx: Ctx, input: NewExpense): { expense: Expense; shares: ExpenseShare[] } {
  const now = ctx.now();
  const hasReceipt = !!input.receipt && (input.receipt.totalCents !== undefined || !!input.receipt.hash);
  const expense: Expense = {
    id: newId("exp"),
    groupId: input.groupId,
    payerId: input.payerId,
    description: input.description,
    totalCents: input.totalCents,
    merchant: input.receipt?.merchant ?? null,
    receiptUrl: input.receipt?.url ?? null,
    receiptHash: input.receipt?.hash ?? null,
    receiptTotalCents: input.receipt?.totalCents ?? null,
    receiptDate: input.receipt?.date ?? null,
    flags: input.flags,
    status: "active",
    sourceDmId: input.sourceDmId ?? null,
    sourceText: input.sourceText ?? null,
    createdAt: now,
  };
  const shares: ExpenseShare[] = input.shares.map((s) => ({
    id: newId("shr"),
    expenseId: expense.id,
    userId: s.userId,
    cents: s.cents,
    disputeReason: null,
    ...initialShare({ userId: s.userId, payerId: input.payerId, hasReceipt, now, autoApproveMs: timings(ctx.config).autoApproveMs }),
  }));
  ctx.db.transaction((tx) => {
    tx.insert(expenses).values(expense).run();
    if (shares.length) tx.insert(expenseShares).values(shares).run();
  });
  audit(ctx, { expenseId: expense.id, actorId: input.payerId, action: "created", detail: input.flags.join(",") || undefined });
  return { expense, shares };
}

export function getExpense(ctx: Ctx, id: string): Expense | undefined {
  return ctx.db.select().from(expenses).where(eq(expenses.id, id)).get();
}

export function getShare(ctx: Ctx, id: string): ExpenseShare | undefined {
  return ctx.db.select().from(expenseShares).where(eq(expenseShares.id, id)).get();
}

export function sharesOf(ctx: Ctx, expenseId: string): ExpenseShare[] {
  return ctx.db.select().from(expenseShares).where(eq(expenseShares.expenseId, expenseId)).all();
}

export function expensesOf(ctx: Ctx, groupId: string): Expense[] {
  return ctx.db.select().from(expenses).where(eq(expenses.groupId, groupId)).orderBy(desc(expenses.createdAt)).all();
}

/** Shares with their expense, group and payer, for building messages. */
export interface ShareDetail {
  share: ExpenseShare;
  expense: Expense;
  group: Group;
  payer: User;
}

function detailQuery(ctx: Ctx) {
  return ctx.db
    .select({ share: expenseShares, expense: expenses, group: groups, payer: users })
    .from(expenseShares)
    .innerJoin(expenses, eq(expenses.id, expenseShares.expenseId))
    .innerJoin(groups, eq(groups.id, expenses.groupId))
    .innerJoin(users, eq(users.id, expenses.payerId));
}

export function shareDetail(ctx: Ctx, shareId: string): ShareDetail | undefined {
  return detailQuery(ctx).where(eq(expenseShares.id, shareId)).get();
}

export function shareDetails(ctx: Ctx, shareIds: string[]): ShareDetail[] {
  if (shareIds.length === 0) return [];
  const rows = detailQuery(ctx).where(inArray(expenseShares.id, shareIds)).all();
  const byId = new Map(rows.map((r) => [r.share.id, r]));
  return shareIds.map((id) => byId.get(id)).filter((r): r is ShareDetail => !!r);
}

/** Everything waiting on this user's OK, oldest first. */
export function pendingSharesFor(ctx: Ctx, userId: string): ShareDetail[] {
  return detailQuery(ctx)
    .where(and(eq(expenseShares.userId, userId), eq(expenseShares.status, "pending"), eq(expenses.status, "active")))
    .orderBy(asc(expenses.createdAt))
    .all();
}

/** This user's shares in a group (any status), newest first. */
export function userSharesInGroup(ctx: Ctx, userId: string, groupId: string): ShareDetail[] {
  return detailQuery(ctx)
    .where(and(eq(expenseShares.userId, userId), eq(expenses.groupId, groupId), eq(expenses.status, "active")))
    .orderBy(desc(expenses.createdAt))
    .all();
}

/** All approved-or-not shares for debt math. Settle only counts approved ones. */
export function ledgerSharesForGroup(ctx: Ctx, groupId: string): LedgerShare[] {
  return ctx.db
    .select({ payerId: expenses.payerId, userId: expenseShares.userId, cents: expenseShares.cents, status: expenseShares.status })
    .from(expenseShares)
    .innerJoin(expenses, eq(expenses.id, expenseShares.expenseId))
    .where(and(eq(expenses.groupId, groupId), eq(expenses.status, "active")))
    .all();
}

export function receiptHistory(ctx: Ctx, groupId: string): PriorExpense[] {
  return ctx.db
    .select({
      receiptHash: expenses.receiptHash,
      merchant: expenses.merchant,
      receiptTotalCents: expenses.receiptTotalCents,
      receiptDate: expenses.receiptDate,
    })
    .from(expenses)
    .where(and(eq(expenses.groupId, groupId), eq(expenses.status, "active")))
    .all();
}

export type ShareActionResult = { ok: true; share: ExpenseShare } | { ok: false; error: TransitionError | "not_found" };

/** Applies a state-machine action to a share and writes the audit trail. */
export function applyShareAction(ctx: Ctx, shareId: string, action: ShareAction): ShareActionResult {
  const share = getShare(ctx, shareId);
  if (!share) return { ok: false, error: "not_found" };
  const expense = getExpense(ctx, share.expenseId);
  if (!expense || expense.status !== "active") return { ok: false, error: "already_final" };
  const result = transition(share, action, ctx.now());
  if (!result.ok) return result;
  ctx.db.update(expenseShares).set(result.patch).where(eq(expenseShares.id, shareId)).run();
  const auditAction: Record<ShareAction["type"], AuditAction> = {
    approve: "approved",
    auto_approve: "approved",
    dispute: "disputed",
    reset: "edited",
    reject: "withdrawn",
  };
  audit(ctx, {
    expenseId: share.expenseId,
    actorId: "actorId" in action ? action.actorId : null,
    action: auditAction[action.type],
    detail:
      action.type === "dispute" ? `${share.userId}: ${action.reason}` : action.type === "auto_approve" ? `${share.userId}: auto` : share.userId,
  });
  return { ok: true, share: getShare(ctx, shareId)! };
}

export function dueAutoApprovals(ctx: Ctx): ExpenseShare[] {
  return ctx.db
    .select({ share: expenseShares })
    .from(expenseShares)
    .innerJoin(expenses, eq(expenses.id, expenseShares.expenseId))
    .where(
      and(
        eq(expenseShares.status, "pending"),
        isNotNull(expenseShares.autoApproveAt),
        lte(expenseShares.autoApproveAt, ctx.now()),
        eq(expenses.status, "active"),
      ),
    )
    .all()
    .map((r) => r.share);
}

/** The payer's most recent expense that has a disputed share. */
export function latestDisputedExpense(ctx: Ctx, payerId: string): Expense | undefined {
  return ctx.db
    .select({ expense: expenses })
    .from(expenses)
    .innerJoin(expenseShares, eq(expenseShares.expenseId, expenses.id))
    .where(and(eq(expenses.payerId, payerId), eq(expenses.status, "active"), eq(expenseShares.status, "disputed")))
    .orderBy(desc(expenses.createdAt))
    .get()?.expense;
}

/** The payer's active expenses that have at least one disputed share, newest first. */
export function disputedExpensesOf(ctx: Ctx, payerId: string, groupId?: string): Expense[] {
  const rows = ctx.db
    .select({ expense: expenses })
    .from(expenses)
    .innerJoin(expenseShares, eq(expenseShares.expenseId, expenses.id))
    .where(and(eq(expenses.payerId, payerId), eq(expenses.status, "active"), eq(expenseShares.status, "disputed")))
    .orderBy(desc(expenses.createdAt))
    .all()
    .map((r) => r.expense);
  const unique = [...new Map(rows.map((e) => [e.id, e])).values()];
  return groupId ? unique.filter((e) => e.groupId === groupId) : unique;
}

/** Payer withdraws: the expense is removed and every share becomes rejected. */
export function withdrawExpense(ctx: Ctx, expenseId: string, actorId: string) {
  ctx.db.transaction((tx) => {
    tx.update(expenses).set({ status: "withdrawn" }).where(eq(expenses.id, expenseId)).run();
    tx.update(expenseShares).set({ status: "rejected", decidedAt: ctx.now() }).where(eq(expenseShares.expenseId, expenseId)).run();
  });
  audit(ctx, { expenseId, actorId, action: "withdrawn" });
}

/**
 * Payer changes the expense (new total and/or receipt). Shares are re-split
 * over the same people, and everyone except the payer has to approve again.
 */
export function reviseExpense(
  ctx: Ctx,
  expenseId: string,
  actorId: string,
  patch: { totalCents: number; shares: ShareAmount[]; flags: ExpenseFlag[]; receipt?: ReceiptInfo & { url?: string } },
): ExpenseShare[] {
  const expense = getExpense(ctx, expenseId)!;
  const hasReceipt = !!(patch.receipt ?? expense.receiptHash ?? expense.receiptTotalCents);
  const now = ctx.now();
  const autoApproveMs = timings(ctx.config).autoApproveMs;
  ctx.db.transaction((tx) => {
    tx.update(expenses)
      .set({
        totalCents: patch.totalCents,
        flags: patch.flags,
        ...(patch.receipt
          ? {
              merchant: patch.receipt.merchant ?? expense.merchant,
              receiptUrl: patch.receipt.url ?? null,
              receiptHash: patch.receipt.hash ?? null,
              receiptTotalCents: patch.receipt.totalCents ?? null,
              receiptDate: patch.receipt.date ?? null,
            }
          : {}),
      })
      .where(eq(expenses.id, expenseId))
      .run();
    tx.delete(expenseShares).where(and(eq(expenseShares.expenseId, expenseId), ne(expenseShares.status, "rejected"))).run();
    tx.insert(expenseShares)
      .values(
        patch.shares.map((s) => ({
          id: newId("shr"),
          expenseId,
          userId: s.userId,
          cents: s.cents,
          disputeReason: null,
          ...initialShare({ userId: s.userId, payerId: expense.payerId, hasReceipt, now, autoApproveMs }),
        })),
      )
      .run();
  });
  audit(ctx, {
    expenseId,
    actorId,
    action: "edited",
    detail: `total ${expense.totalCents} -> ${patch.totalCents}${patch.receipt ? ", receipt added" : ""}`,
  });
  return sharesOf(ctx, expenseId);
}
