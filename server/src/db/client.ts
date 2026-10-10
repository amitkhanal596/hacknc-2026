import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";
export function openDb(path = ".data/tab.sqlite") {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path, { create: true });
  sqlite.exec(
    "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
  );
  if (path !== ":memory:") chmodSync(path, 0o600);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "migrations") });
  sqlite.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END; CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;",
  );
  return { db, sqlite };
}
export type Store = ReturnType<typeof openDb>;
export type Db = Store["db"];
