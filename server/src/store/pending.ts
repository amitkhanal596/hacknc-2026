import { eq } from "drizzle-orm";
import type { Ctx } from "../context";
import { pendingMessages } from "../db/schema";
import type { InboundDM } from "../messaging/types";
import { newId } from "../ids";

/** Pending messages expire so an old photo can't be logged by a much later "1". */
const TTL_MS = 30 * 60 * 1000;

export async function savePendingMessage(ctx: Ctx, userId: string, msg: InboundDM): Promise<void> {
  const image = msg.images[0];
  const row = {
    userId,
    text: msg.text,
    imageData: image ? await image.read() : null,
    imageMime: image?.mimeType ?? null,
    imageName: image?.name ?? null,
    createdAt: ctx.now(),
  };
  ctx.db.insert(pendingMessages).values(row).onConflictDoUpdate({ target: pendingMessages.userId, set: row }).run();
}

/** Returns the saved message (as if it just arrived) and removes it. */
export function takePendingMessage(ctx: Ctx, userId: string, from: string): InboundDM | undefined {
  const row = ctx.db.select().from(pendingMessages).where(eq(pendingMessages.userId, userId)).get();
  if (!row) return undefined;
  ctx.db.delete(pendingMessages).where(eq(pendingMessages.userId, userId)).run();
  if (ctx.now() - row.createdAt > TTL_MS) return undefined;
  const data = row.imageData;
  return {
    id: newId("dm"),
    from,
    text: row.text,
    images: data ? [{ name: row.imageName ?? "photo.jpg", mimeType: row.imageMime ?? "image/jpeg", read: async () => data }] : [],
    at: new Date(row.createdAt),
  };
}
