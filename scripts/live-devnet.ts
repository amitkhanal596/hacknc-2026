import { openDb } from "../server/src/db/client";
import { readConfig } from "../server/src/config";
import { seed } from "../server/src/db/seed";
import { createApp } from "../server/src/api/app";
import { and, eq } from "drizzle-orm";
import * as s from "../server/src/db/schema";
import { uid } from "../server/src/domain/ledger";
const config = readConfig();
if (!config.DEMO_MODE || !config.DEMO_CUSTODIAL_WALLETS)
  throw new Error(
    "Explicitly enable DEMO_MODE and DEMO_CUSTODIAL_WALLETS for this devnet-only CLI demonstration.",
  );
const store = openDb(config.DATABASE_URL),
  group = seed(store.db, true),
  h = createApp(store, config);
try {
  if (!h.solana.capability.available)
    throw new Error(
      "Complete bun run setup:devnet and configure wallet encryption first.",
    );
  const e = h.ledger.propose("alex", {
    groupId: group.id,
    payerId: "alex",
    description: "Devnet mixed-payment demonstration: groceries",
    totalCents: 12000,
    currency: "USD",
    participants: ["alex", "ben", "casey", "drew"],
  });
  h.ledger.review(e.id, "alex", "confirm");
  await h.solana.provision("alex");
  await h.solana.provision("ben");
  const plan = h.ledger.plan(group.id, "alex"),
    ben = plan.find((i) => i.fromId === "ben")!;
  const a = await h.payments.choose(ben.id, "ben", "solana", uid());
  console.log(
    `Explicit CLI demo authorization: Ben sends exactly 30.00 devnet tUSD to Alex. Group ${group.id}. No real value.`,
  );
  const approval = h.payments.approval(a.id, "ben");
  const result = await h.payments.authorize(
    a.id,
    "ben",
    approval.token,
    ben.amountCents,
    ben.toId,
  );
  if (result.status !== "onchain_verified")
    throw new Error(
      `Transfer remains ${result.status}. Check its existing signature in the dashboard; do not create a replacement.`,
    );
  console.log(
    "ACTUAL FINALIZED DEVNET TRANSFER:",
    `https://explorer.solana.com/tx/${result.signature}?cluster=devnet`,
  );
  // Intentional manual simulation: no claim to have actually sent money through personal apps.
  for (const [person, method] of [
    ["casey", "venmo"],
    ["drew", "apple_cash"],
  ] as const) {
    const i = plan.find((i) => i.fromId === person)!;
    const original = store.db
      .select()
      .from(s.destinations)
      .where(eq(s.destinations.userId, "alex"))
      .all()
      .find((d) => d.method === method);
    if (!original)
      store.db
        .insert(s.destinations)
        .values({
          id: uid(),
          userId: "alex",
          method,
          address:
            method === "venmo"
              ? "demo-fixture-not-a-real-payee"
              : "demo@example.test",
          hint: "CLI SIMULATION ONLY",
          verified: true,
        })
        .run();
    const a = await h.payments.choose(i.id, person, method, uid());
    h.payments.claim(a.id, person, "CLI fixture: manual payment simulated");
    h.payments.confirm(a.id, "alex");
    if (!original)
      store.db
        .delete(s.destinations)
        .where(
          and(
            eq(s.destinations.userId, "alex"),
            eq(s.destinations.method, method),
          ),
        )
        .run();
    console.log(
      `${method}: sender claim and independent recipient identity confirmation simulated; no provider API verification.`,
    );
  }
  console.log("Final balances:", h.ledger.balances(group.id));
} finally {
  store.sqlite.close();
}
