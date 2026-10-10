import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
const id = () => text("id").primaryKey();
const created = () =>
  integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now());
export const users = sqliteTable("users", {
  id: id(),
  name: text("display_name").notNull(),
  createdAt: created(),
});
export const identities = sqliteTable(
  "messaging_identities",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    createdAt: created(),
  },
  (t) => [uniqueIndex("identity_provider").on(t.provider, t.providerUserId)],
);
export const groups = sqliteTable(
  "groups",
  {
    id: id(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    spaceId: text("provider_space_id").notNull(),
    metadata: text("metadata_json").notNull().default("{}"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("group_provider").on(t.provider, t.spaceId)],
);
export const members = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["owner", "member"] })
      .notNull()
      .default("member"),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);
export const expenses = sqliteTable(
  "expenses",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    payerId: text("payer_user_id").references(() => users.id),
    description: text("description").notNull(),
    currency: text("currency").notNull().default("USD"),
    totalCents: integer("total_cents").notNull(),
    status: text("status", {
      enum: ["pending", "confirmed", "rejected", "voided"],
    })
      .notNull()
      .default("pending"),
    sourceId: text("source_message_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    confirmedBy: text("confirmed_by").references(() => users.id),
    confirmedAt: integer("confirmed_at"),
    version: integer("version").notNull().default(1),
    createdAt: created(),
  },
  (t) => [
    index("expenses_group").on(t.groupId),
    uniqueIndex("expense_source").on(t.groupId, t.sourceId),
    check(
      "expense_positive",
      sql`${t.totalCents} > 0 AND ${t.currency} = 'USD'`,
    ),
  ],
);
export const shares = sqliteTable(
  "expense_shares",
  {
    expenseId: text("expense_id")
      .notNull()
      .references(() => expenses.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    cents: integer("share_cents").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.expenseId, t.userId] }),
    check("share_nonnegative", sql`${t.cents} >= 0`),
  ],
);
export const destinations = sqliteTable(
  "payment_destinations",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    method: text("method").notNull(),
    address: text("handle_or_address").notNull(),
    hint: text("display_hint").notNull(),
    verified: integer("verified_for_display", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: created(),
  },
  (t) => [uniqueIndex("destination_owner_method").on(t.userId, t.method)],
);
export const intents = sqliteTable(
  "settlement_intents",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    fromId: text("from_user_id")
      .notNull()
      .references(() => users.id),
    toId: text("to_user_id")
      .notNull()
      .references(() => users.id),
    currency: text("currency").notNull().default("USD"),
    amountCents: integer("amount_cents").notNull(),
    confirmedCents: integer("amount_confirmed_cents").notNull().default(0),
    status: text("status", { enum: ["pending", "settled", "cancelled"] })
      .notNull()
      .default("pending"),
    expiresAt: integer("expires_at").notNull(),
    version: integer("version").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: created(),
  },
  (t) => [
    index("intent_group").on(t.groupId),
    check(
      "intent_valid",
      sql`${t.amountCents} > 0 AND ${t.confirmedCents} >= 0 AND ${t.confirmedCents} <= ${t.amountCents} AND ${t.fromId} != ${t.toId} AND ${t.currency} = 'USD'`,
    ),
  ],
);
export const attempts = sqliteTable(
  "payment_attempts",
  {
    id: id(),
    intentId: text("intent_id")
      .notNull()
      .references(() => intents.id),
    method: text("method").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull(),
    destination: text("recipient_destination_snapshot").notNull(),
    externalReference: text("external_reference"),
    signature: text("tx_signature").unique(),
    network: text("network"),
    mint: text("token_mint"),
    rawTransaction: text("signed_transaction"),
    lastValidBlockHeight: integer("last_valid_block_height"),
    chainExpected: text("chain_expected_json"),
    claimedAt: integer("sender_claimed_at"),
    confirmedAt: integer("recipient_confirmed_at"),
    verifiedAt: integer("verified_at"),
    failure: text("failure_reason"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: created(),
  },
  (t) => [
    index("attempt_intent").on(t.intentId),
    uniqueIndex("one_active_attempt")
      .on(t.intentId)
      .where(sql`${t.status} NOT IN ('cancelled', 'failed', 'expired')`),
    check("attempt_positive", sql`${t.amountCents} > 0`),
  ],
);
export const credits = sqliteTable(
  "settlement_credits",
  {
    attemptId: text("attempt_id")
      .primaryKey()
      .references(() => attempts.id),
    intentId: text("intent_id")
      .notNull()
      .unique()
      .references(() => intents.id),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    fromId: text("from_user_id")
      .notNull()
      .references(() => users.id),
    toId: text("to_user_id")
      .notNull()
      .references(() => users.id),
    cents: integer("cents").notNull(),
    kind: text("verification_kind", {
      enum: ["on_chain", "recipient_confirmation"],
    }).notNull(),
    createdAt: created(),
  },
  (t) => [check("credit_positive", sql`${t.cents} > 0`)],
);
export const assets = sqliteTable(
  "receipt_assets",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    expenseId: text("expense_id").references(() => expenses.id),
    digest: text("digest").notNull(),
    mime: text("mime").notNull(),
    uploader: text("uploader").references(() => users.id),
    purpose: text("purpose").notNull().default("expense"),
    data: text("private_base64"),
    parserStatus: text("parser_status").notNull(),
    extracted: text("extracted_json"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("asset_group_digest").on(t.groupId, t.digest)],
);
export const evidence = sqliteTable("payment_evidence", {
  id: id(),
  attemptId: text("attempt_id")
    .notNull()
    .references(() => attempts.id),
  assetId: text("asset_id").references(() => assets.id),
  note: text("note"),
  uploader: text("uploader")
    .notNull()
    .references(() => users.id),
  createdAt: created(),
});
export const audit = sqliteTable(
  "audit_events",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    actorId: text("actor_id").references(() => users.id),
    type: text("type").notNull(),
    entityId: text("entity_id").notNull(),
    details: text("details_json").notNull().default("{}"),
    createdAt: created(),
  },
  (t) => [index("audit_group").on(t.groupId)],
);
export const processed = sqliteTable(
  "processed_messages",
  {
    provider: text("provider").notNull(),
    messageId: text("provider_message_id").notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    state: text("state").notNull(),
    result: text("result_json"),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.messageId] })],
);
export const tokens = sqliteTable("one_time_tokens", {
  hash: text("hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  purpose: text("purpose").notNull(),
  binding: text("binding").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  createdAt: created(),
});
export const sessions = sqliteTable("sessions", {
  hash: text("hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  scope: text("scope").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
export const wallets = sqliteTable("demo_wallets", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  address: text("address").notNull().unique(),
  encryptedSecret: text("encrypted_secret").notNull(),
  mint: text("mint").notNull(),
  createdAt: created(),
});
export const outbox = sqliteTable("outbox", {
  id: id(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
  text: text("text").notNull(),
  recipientId: text("recipient_user_id").references(() => users.id),
  state: text("state").notNull().default("pending"),
  tries: integer("tries").notNull().default(0),
  nextAt: integer("next_at").notNull().default(0),
  createdAt: created(),
});
export const tabInvites = sqliteTable("tab_invites", {
  hash: text("hash").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
  createdAt: created(),
});
export const dmContexts = sqliteTable("dm_contexts", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
});
export const dmPreferences = sqliteTable("dm_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});
export const dmRequests = sqliteTable("dm_requests", {
  key: text("key").primaryKey(),
  actorId: text("actor_id")
    .notNull()
    .references(() => users.id),
  result: text("result_json").notNull(),
  createdAt: created(),
});
export const reminders = sqliteTable(
  "reminder_state",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    lastAt: integer("last_at"),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);
export type Expense = typeof expenses.$inferSelect;
export type Intent = typeof intents.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
export type Destination = typeof destinations.$inferSelect;
