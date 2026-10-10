import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Timestamps are unix milliseconds. Money is integer cents.

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  displayName: text("display_name"),
  activeGroupId: text("active_group_id"),
  /** The Photon shared-pool line this person texts (each person can have a different one). */
  photonLine: text("photon_line"),
  walletPubkey: text("wallet_pubkey"),
  walletSecretEnc: text("wallet_secret_enc"),
  stripeAccountId: text("stripe_account_id"),
  stripePayoutsEnabled: integer("stripe_payouts_enabled", { mode: "boolean" }).notNull().default(false),
  verifiedAt: integer("verified_at"),
  createdAt: integer("created_at").notNull(),
});

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["trip", "roommates", "dinner", "club"] }).notNull().default("trip"),
  joinCode: text("join_code").notNull().unique(),
  organizerId: text("organizer_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    joinedAt: integer("joined_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const dmMessages = sqliteTable(
  "dm_messages",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    text: text("text"),
    attachmentUrl: text("attachment_url"),
    at: integer("at").notNull(),
  },
  (t) => [index("dm_user_at").on(t.userId, t.at)],
);

export type ExpenseFlag = "no_receipt" | "amount_mismatch" | "possible_duplicate";

export const expenses = sqliteTable(
  "expenses",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    payerId: text("payer_id").notNull(),
    description: text("description").notNull(),
    totalCents: integer("total_cents").notNull(),
    merchant: text("merchant"),
    receiptUrl: text("receipt_url"),
    receiptHash: text("receipt_hash"),
    receiptTotalCents: integer("receipt_total_cents"),
    receiptDate: text("receipt_date"),
    flags: text("flags", { mode: "json" }).$type<ExpenseFlag[]>().notNull().default([]),
    status: text("status", { enum: ["active", "withdrawn"] }).notNull().default("active"),
    sourceDmId: text("source_dm_id"),
    sourceText: text("source_text"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("expenses_group").on(t.groupId)],
);

export type ShareStatus = "pending" | "approved" | "disputed" | "rejected";
export type ApprovedVia = "reply" | "extension" | "auto" | "payer";

export const expenseShares = sqliteTable(
  "expense_shares",
  {
    id: text("id").primaryKey(),
    expenseId: text("expense_id").notNull(),
    userId: text("user_id").notNull(),
    cents: integer("cents").notNull(),
    status: text("status", { enum: ["pending", "approved", "disputed", "rejected"] }).notNull(),
    approvedVia: text("approved_via", { enum: ["reply", "extension", "auto", "payer"] }),
    decidedAt: integer("decided_at"),
    autoApproveAt: integer("auto_approve_at"),
    disputeReason: text("dispute_reason"),
  },
  (t) => [index("shares_expense").on(t.expenseId), index("shares_user").on(t.userId)],
);

export type AuditAction = "created" | "edited" | "approved" | "disputed" | "resolved" | "withdrawn" | "paid";

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    expenseId: text("expense_id"),
    paymentId: text("payment_id"),
    actorId: text("actor_id"),
    action: text("action").$type<AuditAction>().notNull(),
    detail: text("detail"),
    at: integer("at").notNull(),
  },
  (t) => [index("audit_expense").on(t.expenseId)],
);

export type PaymentRail = "solana" | "apple_pay";
export type PaymentStatus = "pending" | "confirmed" | "held" | "released" | "failed";

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    cents: integer("cents").notNull(),
    rail: text("rail", { enum: ["solana", "apple_pay"] }).notNull(),
    status: text("status", { enum: ["pending", "confirmed", "held", "released", "failed"] }).notNull(),
    solanaTxSig: text("solana_tx_sig"),
    simulated: integer("simulated", { mode: "boolean" }).notNull().default(false),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id"),
    stripeTransferId: text("stripe_transfer_id"),
    createdAt: integer("created_at").notNull(),
    confirmedAt: integer("confirmed_at"),
  },
  (t) => [index("payments_group").on(t.groupId), uniqueIndex("payments_pi").on(t.stripePaymentIntentId)],
);

export const reminders = sqliteTable(
  "reminders",
  {
    userId: text("user_id").notNull(),
    groupId: text("group_id").notNull(),
    kind: text("kind", { enum: ["debt", "review"] }).notNull(),
    lastSentAt: integer("last_sent_at").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId, t.kind] })],
);

export const authCodes = sqliteTable("auth_codes", {
  phone: text("phone").primaryKey(),
  codeHash: text("code_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
});

/**
 * What a bare reply like "YES 1 3" or "firewood" refers to. At most one open
 * prompt per user per kind; a new one replaces the old, and expired ones are ignored.
 */
export type PendingPrompt =
  /** Numbered list of shares we showed them: "YES 1 3" refers to these. */
  | { kind: "approve"; shareIds: string[] }
  /** We asked "what was the $20 for?"; the next message is the reason. */
  | { kind: "reason"; groupId: string; amountCents: number; participants: "all" | string[]; sourceText: string | null }
  /** We asked "what should I call you?". Once answered, tell this group they joined. */
  | { kind: "name"; announceGroupId?: string }
  /** Someone disputed this payer's expense; FIX / WITHDRAW / a receipt photo apply to it. */
  | { kind: "fix"; expenseId: string };

export const pendingPrompts = sqliteTable(
  "pending_prompts",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").$type<PendingPrompt["kind"]>().notNull(),
    payload: text("payload", { mode: "json" }).$type<PendingPrompt>().notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

export type User = typeof users.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type ExpenseShare = typeof expenseShares.$inferSelect;
export type Payment = typeof payments.$inferSelect;
