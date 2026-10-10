import { openDb } from "../server/src/db/client";
import { readConfig } from "../server/src/config";
import { seed } from "../server/src/db/seed";
const config = readConfig();
if (!config.DEMO_MODE) throw new Error("Demo seed requires DEMO_MODE=true.");
const { db, sqlite } = openDb(config.DATABASE_URL);
seed(db);
sqlite.close();
console.log(
  "Seeded Alex, Ben, Casey and Drew in Tahoe. No wallets or invented payment handles created.",
);
