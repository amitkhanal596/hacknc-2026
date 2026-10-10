import { eq } from "drizzle-orm";
import type { Ctx } from "../context";
import { receiptImages } from "../db/schema";

/** Photos larger than this aren't stored (iPhone photos are usually 1–4 MB). */
const MAX_BYTES = 10 * 1024 * 1024;

export function saveReceiptImage(ctx: Ctx, expenseId: string, mimeType: string, data: Buffer): boolean {
  if (data.length > MAX_BYTES) return false;
  const row = { expenseId, mimeType, data, createdAt: ctx.now() };
  ctx.db.insert(receiptImages).values(row).onConflictDoUpdate({ target: receiptImages.expenseId, set: row }).run();
  return true;
}

export function getReceiptImage(ctx: Ctx, expenseId: string) {
  return ctx.db.select().from(receiptImages).where(eq(receiptImages.expenseId, expenseId)).get();
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp" };

export function receiptFileName(description: string, mimeType: string): string {
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "receipt";
  return `${slug}-receipt.${EXT[mimeType] ?? "jpg"}`;
}
