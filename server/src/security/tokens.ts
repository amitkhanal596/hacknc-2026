import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { tokens, sessions } from "../db/schema";
import { ensure } from "../domain/money";
export const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class Auth {
  constructor(public db: Db) {}
  issue(userId: string, purpose: string, binding: string, ttl = 300_000) {
    const token = randomBytes(32).toString("base64url");
    this.db
      .insert(tokens)
      .values({
        hash: hash(token),
        userId,
        purpose,
        binding,
        expiresAt: Date.now() + ttl,
      })
      .run();
    return token;
  }
  consume(token: string, userId: string, purpose: string, binding: string) {
    const changed = this.db
      .update(tokens)
      .set({ consumedAt: Date.now() })
      .where(
        and(
          eq(tokens.hash, hash(token)),
          eq(tokens.userId, userId),
          eq(tokens.purpose, purpose),
          eq(tokens.binding, binding),
          gt(tokens.expiresAt, Date.now()),
          isNull(tokens.consumedAt),
        ),
      )
      .returning({ hash: tokens.hash })
      .get();
    ensure(
      !!changed,
      "INVALID_APPROVAL",
      "Approval is invalid, expired or already used.",
      403,
    );
  }
  session(userId: string, scope: "demo" | "photon") {
    const token = randomBytes(32).toString("base64url");
    this.db
      .insert(sessions)
      .values({
        hash: hash(token),
        userId,
        scope,
        expiresAt: Date.now() + 8 * 3600_000,
      })
      .run();
    return token;
  }
  lookup(token: string) {
    return this.db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.hash, hash(token)), gt(sessions.expiresAt, Date.now())),
      )
      .get();
  }
}
