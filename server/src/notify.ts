import type { Ctx } from "./context";
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
