import { and, eq, lt, lte } from "drizzle-orm";
import type { Runtime } from "../api/app";
import * as s from "../db/schema";
export function recoverInterrupted(runtime: Runtime) {
  // A pre-broadcast crash with no persisted signature cannot have moved tokens.
  runtime.store.db
    .update(s.attempts)
    .set({
      status: "failed",
      failure:
        "Server restarted before signing/broadcast. Prepare a new attempt.",
    })
    .where(and(eq(s.attempts.status, "submitting")))
    .run();
}
export async function reconcile(runtime: Runtime) {
  const attempts = runtime.store.db
    .select()
    .from(s.attempts)
    .where(eq(s.attempts.status, "submitted"))
    .all();
  for (const a of attempts) {
    try {
      await runtime.solana.reconcile(a.id);
    } catch {
      /* Remains unresolved; no new transfer is signed. */
    }
  }
  runtime.assets.cleanup();
}
const flushing = new WeakSet<Runtime>();
export async function flushOutbox(
  runtime: Runtime,
  send?: (
    group: typeof s.groups.$inferSelect,
    text: string,
    recipientId?: string | null,
  ) => Promise<void>,
) {
  if (flushing.has(runtime)) return;
  flushing.add(runtime);
  try {
    const pending = runtime.store.db
      .select()
      .from(s.outbox)
      .where(
        and(
          eq(s.outbox.state, "pending"),
          lte(s.outbox.nextAt, Date.now()),
          lt(s.outbox.tries, 5),
        ),
      )
      .limit(20)
      .all();
    for (const row of pending) {
      const group = runtime.store.db
        .select()
        .from(s.groups)
        .where(eq(s.groups.id, row.groupId))
        .get()!;
      if (group.provider !== "mock" && !send) continue;
      if (row.recipientId) {
        const preference = runtime.store.db
          .select()
          .from(s.dmPreferences)
          .where(eq(s.dmPreferences.userId, row.recipientId))
          .get();
        if (preference?.enabled === false) {
          runtime.store.db
            .update(s.outbox)
            .set({ state: "suppressed" })
            .where(eq(s.outbox.id, row.id))
            .run();
          continue;
        }
      }
      try {
        if (group.provider !== "mock")
          await send!(group, row.text, row.recipientId);
        runtime.store.db
          .update(s.outbox)
          .set({ state: group.provider === "mock" ? "simulated" : "sent" })
          .where(eq(s.outbox.id, row.id))
          .run();
      } catch {
        runtime.store.db
          .update(s.outbox)
          .set({
            tries: row.tries + 1,
            state: row.tries + 1 >= 5 ? "failed" : "pending",
            nextAt: Date.now() + Math.min(3600_000, 10_000 * 2 ** row.tries),
          })
          .where(eq(s.outbox.id, row.id))
          .run();
      }
    }
  } finally {
    flushing.delete(runtime);
  }
}
