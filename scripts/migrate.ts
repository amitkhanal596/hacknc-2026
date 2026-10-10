import { openDb } from "../server/src/db/client";
import { readConfig } from "../server/src/config";
const { sqlite } = openDb(readConfig().DATABASE_URL);
sqlite.close();
console.log("SQLite migrations applied.");
