import type { Ctx } from "../context";
import { timings } from "../context";
import { ASK_NAME, listOf } from "../copy";
import type { Group, User } from "../db/schema";
import { dm } from "../notify";
import { setPrompt } from "../store/dms";
import { addMember, membersOf } from "../store/groups";
import { ensureWallet, getUser, nameOf, updateUser } from "../store/users";

/**
 * Makes sure Photon's shared line is allowed to text this person (registering
 * them if needed) and remembers which line they were assigned. No-op without
 * Photon (simulator/tests). Returns the line they should text, if known.
 */
export async function ensureMessagingAccess(ctx: Ctx, user: User): Promise<string | undefined> {
  if (!ctx.registerMessagingUser) return undefined;
  if (user.photonLine) return user.photonLine;
  const { assignedPhoneNumber } = await ctx.registerMessagingUser(user.phone, user.displayName);
  updateUser(ctx, user.id, { photonLine: assignedPhoneNumber });
  return assignedPhoneNumber;
}

/**
 * Adds a user to a group and sends the welcome / name prompt / join
 * announcement. Used by the JOIN text command and the web join page.
 */
export async function joinGroup(ctx: Ctx, userIn: User, group: Group, name?: string): Promise<{ added: boolean }> {
  let user = userIn;
  const added = addMember(ctx, group.id, user.id);
  if (name) user = updateUser(ctx, user.id, { displayName: name });
  user = await ensureWallet(ctx, user);
  if (!added) {
    await dm(ctx, user.id, `You're already in ${group.name}. I've made it your active group.`);
    return { added };
  }
  const others = membersOf(ctx, group.id).filter((m) => m.id !== user.id).map(nameOf);
  await dm(
    ctx,
    user.id,
    `You're in ${group.name}${others.length ? ` with ${listOf(others)}` : ""}! Text me receipts or "paid $X for Y" and I'll keep a running tab. I'll text you whenever something's logged, and nobody pays until someone texts SETTLE.`,
  );
  if (user.displayName) {
    await announceJoin(ctx, user.id, group);
  } else {
    setPrompt(ctx, user.id, { kind: "name", announceGroupId: group.id }, timings(ctx.config).promptTtlMs);
    await dm(ctx, user.id, ASK_NAME);
  }
  return { added };
}

export async function announceJoin(ctx: Ctx, userId: string, group: Group) {
  const user = getUser(ctx, userId);
  for (const m of membersOf(ctx, group.id)) {
    if (m.id !== userId) await dm(ctx, m.id, `👋 ${nameOf(user)} joined ${group.name}.`);
  }
}
