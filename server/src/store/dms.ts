import { and, desc, eq } from "drizzle-orm";
import type { Ctx } from "../context";
import { dmMessages, pendingPrompts, type PendingPrompt } from "../db/schema";
import { newId } from "../ids";

export function logDM(ctx: Ctx, userId: string, direction: "in" | "out", text: string | null, attachmentUrl?: string): string {
  const id = newId("dm");
  ctx.db.insert(dmMessages).values({ id, userId, direction, text, attachmentUrl: attachmentUrl ?? null, at: ctx.now() }).run();
  return id;
}

/** The user's last few inbound texts, oldest first (context for Gemini). */
export function recentInbound(ctx: Ctx, userId: string, limit = 20): string[] {
  return ctx.db
    .select({ text: dmMessages.text })
    .from(dmMessages)
    .where(and(eq(dmMessages.userId, userId), eq(dmMessages.direction, "in")))
    .orderBy(desc(dmMessages.at))
    .limit(limit)
    .all()
    .map((r) => r.text)
    .filter((t): t is string => !!t)
    .reverse();
}

export function getDM(ctx: Ctx, id: string) {
  return ctx.db.select().from(dmMessages).where(eq(dmMessages.id, id)).get();
}

export function setPrompt(ctx: Ctx, userId: string, payload: PendingPrompt, ttlMs: number) {
  const expiresAt = ctx.now() + ttlMs;
  ctx.db
    .insert(pendingPrompts)
    .values({ userId, kind: payload.kind, payload, expiresAt })
    .onConflictDoUpdate({ target: [pendingPrompts.userId, pendingPrompts.kind], set: { payload, expiresAt } })
    .run();
}

export function getPrompt<K extends PendingPrompt["kind"]>(
  ctx: Ctx,
  userId: string,
  kind: K,
): Extract<PendingPrompt, { kind: K }> | undefined {
  const row = ctx.db
    .select()
    .from(pendingPrompts)
    .where(and(eq(pendingPrompts.userId, userId), eq(pendingPrompts.kind, kind)))
    .get();
  if (!row || row.expiresAt < ctx.now()) return undefined;
  return row.payload as Extract<PendingPrompt, { kind: K }>;
}

export function clearPrompt(ctx: Ctx, userId: string, kind: PendingPrompt["kind"]) {
  ctx.db.delete(pendingPrompts).where(and(eq(pendingPrompts.userId, userId), eq(pendingPrompts.kind, kind))).run();
}
