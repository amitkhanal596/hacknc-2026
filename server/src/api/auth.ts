import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Ctx } from "../context";
import { authCodes } from "../db/schema";
import { sixDigitCode } from "../ids";
import { normalizeHandle } from "../messaging/types";
import { signToken, verifyToken } from "../payments/tokens";
import { getOrCreateUser, getUserByPhone, updateUser } from "../store/users";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashCode(ctx: Ctx, phone: string, code: string) {
  return createHash("sha256").update(`${ctx.config.appSecret}:${phone}:${code}`).digest("hex");
}

/** Texts a 6-digit login code to the phone through the bot. Codes are hashed, expire, and are rate-limited. */
export async function startLogin(ctx: Ctx, rawPhone: string): Promise<{ ok: boolean; message: string }> {
  const phone = normalizeHandle(rawPhone);
  const existing = ctx.db.select().from(authCodes).where(eq(authCodes.phone, phone)).get();
  if (existing && existing.expiresAt - CODE_TTL_MS + 30_000 > ctx.now()) {
    return { ok: false, message: "A code was just sent. Wait 30 seconds before asking for another." };
  }
  const code = sixDigitCode();
  const row = { phone, codeHash: hashCode(ctx, phone, code), expiresAt: ctx.now() + CODE_TTL_MS, attempts: 0 };
  ctx.db.insert(authCodes).values(row).onConflictDoUpdate({ target: authCodes.phone, set: row }).run();
  const user = getOrCreateUser(ctx, phone);
  await ctx.messenger.send(user.phone, `Your Tab login code is ${code}. It expires in 10 minutes. Don't share it with anyone.`);
  return { ok: true, message: "Code sent." };
}

export function verifyLogin(ctx: Ctx, rawPhone: string, code: string): { ok: true; token: string; userId: string } | { ok: false; message: string } {
  const phone = normalizeHandle(rawPhone);
  const row = ctx.db.select().from(authCodes).where(eq(authCodes.phone, phone)).get();
  if (!row || row.expiresAt < ctx.now()) return { ok: false, message: "That code expired. Request a new one." };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, message: "Too many tries. Request a new code." };
  ctx.db.update(authCodes).set({ attempts: row.attempts + 1 }).where(eq(authCodes.phone, phone)).run();

  const expected = Buffer.from(row.codeHash, "hex");
  const given = Buffer.from(hashCode(ctx, phone, code.trim()), "hex");
  if (!timingSafeEqual(expected, given)) return { ok: false, message: "That code isn't right." };

  ctx.db.delete(authCodes).where(eq(authCodes.phone, phone)).run();
  const user = getUserByPhone(ctx, phone)!;
  updateUser(ctx, user.id, { verifiedAt: ctx.now() });
  return { ok: true, userId: user.id, token: signToken({ t: "api", userId: user.id, exp: ctx.now() + TOKEN_TTL_MS }, ctx.config.appSecret) };
}

export function userIdFromBearer(ctx: Ctx, header: string | undefined): string | undefined {
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token) return undefined;
  return verifyToken(token, ctx.config.appSecret, "api", ctx.now())?.userId;
}
