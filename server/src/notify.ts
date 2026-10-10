import type { Ctx } from "./context";
import type { OutboundImage } from "./messaging/types";
import { logDM } from "./store/dms";
import { getUser } from "./store/users";

/** Sends a DM to a user and logs it. Send failures are logged, never thrown, so one bad number can't break a fan-out. */
export async function dm(ctx: Ctx, userId: string, text: string): Promise<void> {
  const user = getUser(ctx, userId);
  if (!user) return;
  try {
    await ctx.messenger.send(user.phone, text);
    logDM(ctx, userId, "out", text);
  } catch (err) {
    console.error(`[notify] failed to DM ${userId}:`, (err as Error).message);
  }
}

/** Sends a photo (e.g. the receipt behind an expense). Failures are logged, never thrown. */
export async function dmImage(ctx: Ctx, userId: string, image: OutboundImage): Promise<void> {
  const user = getUser(ctx, userId);
  if (!user) return;
  try {
    await ctx.messenger.sendImage(user.phone, image);
    logDM(ctx, userId, "out", null, `image:${image.mimeType}`);
  } catch (err) {
    console.error(`[notify] failed to send a photo to ${userId}:`, (err as Error).message);
  }
}
