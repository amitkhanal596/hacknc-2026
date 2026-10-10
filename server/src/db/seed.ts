import { eq } from "drizzle-orm";
import type { Db } from "./client";
import * as s from "./schema";
import { uid } from "../domain/ledger";
export const demoPeople = [
  { id: "alex", name: "Alex" },
  { id: "ben", name: "Ben" },
  { id: "casey", name: "Casey" },
  { id: "drew", name: "Drew" },
];
export function seed(db: Db, fresh = false) {
  const groupId = fresh ? `tahoe-${uid()}` : "tahoe";
  db.transaction(() => {
    for (const person of demoPeople) {
      db.insert(s.users).values(person).onConflictDoNothing().run();
      db.insert(s.identities)
        .values({
          id: `mock-${person.id}`,
          userId: person.id,
          provider: "mock",
          providerUserId: person.id,
          verified: true,
        })
        .onConflictDoNothing()
        .run();
    }
    db.insert(s.groups)
      .values({
        id: groupId,
        name: "Tahoe weekend",
        provider: "mock",
        spaceId: groupId,
        metadata: JSON.stringify({ dates: "Nov 13–16", simulation: true }),
      })
      .onConflictDoNothing()
      .run();
    for (const person of demoPeople)
      db.insert(s.members)
        .values({
          groupId,
          userId: person.id,
          role: person.id === "alex" ? "owner" : "member",
        })
        .onConflictDoNothing()
        .run();
  });
  return db.select().from(s.groups).where(eq(s.groups.id, groupId)).get()!;
}
