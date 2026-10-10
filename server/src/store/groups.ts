import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Ctx } from "../context";
import { groupMembers, groups, users, type Group, type User } from "../db/schema";
import { newId, newJoinCode } from "../ids";
import { updateUser } from "./users";

export function getGroup(ctx: Ctx, id: string): Group | undefined {
  return ctx.db.select().from(groups).where(eq(groups.id, id)).get();
}

export function getGroupByCode(ctx: Ctx, code: string): Group | undefined {
  return ctx.db.select().from(groups).where(eq(groups.joinCode, code.trim().toUpperCase())).get();
}

export function createGroup(ctx: Ctx, organizer: User, name: string, kind: Group["kind"] = "trip"): Group {
  let joinCode = newJoinCode(name);
  while (getGroupByCode(ctx, joinCode)) joinCode = newJoinCode(name);
  const group: Group = { id: newId("grp"), name, kind, joinCode, organizerId: organizer.id, createdAt: ctx.now() };
  ctx.db.insert(groups).values(group).run();
  addMember(ctx, group.id, organizer.id);
  return group;
}

export function isMember(ctx: Ctx, groupId: string, userId: string): boolean {
  return !!ctx.db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .get();
}

/** Adds the user (no-op if already a member) and makes it their active group. Returns true if newly added. */
export function addMember(ctx: Ctx, groupId: string, userId: string): boolean {
  const already = isMember(ctx, groupId, userId);
  if (!already) ctx.db.insert(groupMembers).values({ groupId, userId, joinedAt: ctx.now() }).run();
  updateUser(ctx, userId, { activeGroupId: groupId });
  return !already;
}

/** Members in join order. */
export function membersOf(ctx: Ctx, groupId: string): User[] {
  return ctx.db
    .select({ user: users })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.joinedAt), asc(sql`${groupMembers}.rowid`))
    .all()
    .map((r) => r.user);
}

export function groupsOf(ctx: Ctx, userId: string): Group[] {
  const ids = ctx.db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId)).all();
  if (ids.length === 0) return [];
  return ctx.db
    .select()
    .from(groups)
    .where(inArray(groups.id, ids.map((r) => r.id)))
    .orderBy(asc(groups.createdAt))
    .all();
}

/** The user's active group, if they're still a member of it. */
export function activeGroup(ctx: Ctx, user: User): Group | undefined {
  if (!user.activeGroupId || !isMember(ctx, user.activeGroupId, user.id)) return undefined;
  return getGroup(ctx, user.activeGroupId);
}

/** Finds one of the user's groups by join code or (partial, case-insensitive) name. */
export function findUserGroup(ctx: Ctx, userId: string, query: string): Group | undefined {
  const q = query.trim().toLowerCase();
  const mine = groupsOf(ctx, userId);
  return (
    mine.find((g) => g.joinCode.toLowerCase() === q) ??
    mine.find((g) => g.name.toLowerCase() === q) ??
    mine.find((g) => g.name.toLowerCase().includes(q))
  );
}
