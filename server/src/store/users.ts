import { eq } from "drizzle-orm";
import type { Ctx } from "../context";
import { users, type User } from "../db/schema";
import { newId } from "../ids";
import { normalizeHandle } from "../messaging/types";
import { newWallet } from "../payments/solana/wallets";

export function getUser(ctx: Ctx, id: string): User | undefined {
  return ctx.db.select().from(users).where(eq(users.id, id)).get();
}

export function getUserByPhone(ctx: Ctx, phone: string): User | undefined {
  return ctx.db.select().from(users).where(eq(users.phone, normalizeHandle(phone))).get();
}

export function getUserByStripeAccount(ctx: Ctx, accountId: string): User | undefined {
  return ctx.db.select().from(users).where(eq(users.stripeAccountId, accountId)).get();
}

export function getOrCreateUser(ctx: Ctx, phone: string): User {
  const existing = getUserByPhone(ctx, phone);
  if (existing) return existing;
  const user: User = {
    id: newId("usr"),
    phone: normalizeHandle(phone),
    displayName: null,
    activeGroupId: null,
    walletPubkey: null,
    walletSecretEnc: null,
    stripeAccountId: null,
    stripePayoutsEnabled: false,
    verifiedAt: null,
    createdAt: ctx.now(),
  };
  ctx.db.insert(users).values(user).run();
  return user;
}

export function updateUser(ctx: Ctx, id: string, patch: Partial<Omit<User, "id" | "phone">>): User {
  ctx.db.update(users).set(patch).where(eq(users.id, id)).run();
  return getUser(ctx, id)!;
}

/** Display name for messages: the name they gave us, or the last 4 digits of their number. */
export function nameOf(user: Pick<User, "displayName" | "phone"> | undefined): string {
  if (!user) return "someone";
  return user.displayName ?? `…${user.phone.slice(-4)}`;
}

/**
 * Makes a Solana wallet for the user if they don't have one and funds it with
 * test USDC. Funding failures (devnet hiccups) are logged and retried next time.
 */
export async function ensureWallet(ctx: Ctx, user: User): Promise<User> {
  if (user.walletPubkey) return user;
  const wallet = newWallet(ctx.config.walletEncKey);
  const updated = updateUser(ctx, user.id, { walletPubkey: wallet.pubkey, walletSecretEnc: wallet.secretEnc });
  try {
    await ctx.chain.fundNewWallet(wallet.pubkey);
  } catch (err) {
    console.warn(`[solana] couldn't fund wallet for ${user.id}:`, (err as Error).message);
  }
  return updated;
}
