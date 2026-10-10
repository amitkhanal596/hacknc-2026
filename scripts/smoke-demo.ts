import { harness, client } from "../server/src/test/helpers";
import { eq } from "drizzle-orm";
import * as schema from "../server/src/db/schema";
import { flushOutbox } from "../server/src/jobs/reconcile";
import type { Intent, Attempt } from "../server/src/db/schema";
const h = harness(),
  alex = client(h);
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
console.log(
  "OFFLINE SIMULATION: Photon/Gemini fixtures + Solana RPC fixture. No actual on-chain payment.",
);
await alex.login("alex");
const created = await h.direct.handle({
  actorId: "alex",
  provider: "mock",
  messageId: "create",
  text: "create Tahoe",
});
const groupId = created.groupId!;
const invitation = h.direct.invite("alex", groupId);
for (const actorId of ["ben", "casey", "drew"])
  await h.direct.handle({
    actorId,
    provider: "mock",
    messageId: `join-${actorId}`,
    text: `join ${invitation.code}`,
  });
await h.direct.handle({
  actorId: "alex",
  provider: "mock",
  messageId: "smoke-grocery",
  text: "I paid $120 for groceries, split with everyone",
});
const expense = h.store.db
  .select()
  .from(schema.expenses)
  .where(eq(schema.expenses.groupId, groupId))
  .get()!;
check(expense, "Proposal missing");
await alex.request(`/api/expenses/${expense.id}/confirm`, {});
await flushOutbox(h);
const notices = h.store.db
  .select()
  .from(schema.outbox)
  .where(eq(schema.outbox.groupId, groupId))
  .all();
check(
  notices.length === 4 &&
    notices.every(
      (n) =>
        n.recipientId &&
        n.text.includes("Your share: $30.00") &&
        n.state === "simulated",
    ),
  "Private share fanout failed",
);
console.log(
  "Four separate simulated DMs joined one tab; each received a private $30 share notice.",
);
console.log("Confirmed groceries:", h.ledger.balances(groupId));
await alex.request(
  "/api/me/destinations/venmo",
  { address: "alex-demo-fixture", confirmOwnership: true },
  "PUT",
);
await alex.request(
  "/api/me/destinations/apple_cash",
  { address: "alex@example.test", confirmOwnership: true },
  "PUT",
);
const plan = (await alex.request(`/api/groups/${groupId}/settlements/plan`, {}))
  .body.data as Intent[];
for (const [index, method] of (
  ["solana", "venmo", "apple_cash"] as const
).entries()) {
  const i = plan[index]!,
    sender = client(h);
  await sender.login(i.fromId);
  const a = (
    await sender.request(`/api/settlements/${i.id}/choose-method`, {
      method,
      idempotencyKey: `smoke-${index}`,
    })
  ).body.data as Attempt;
  if (method === "solana") {
    const approval = (
      await sender.request(`/api/payment-attempts/${a.id}/approval`, {})
    ).body.data;
    const paid = await sender.request(
      `/api/payment-attempts/${a.id}/authorize-solana`,
      approval,
    );
    check(paid.response.status === 200, "Fixture authorization failed");
    console.log(
      "Ben: $30 Solana RPC fixture verified (SIMULATED, no transaction).",
    );
  } else {
    await sender.request(`/api/payment-attempts/${a.id}/claim-paid`, {
      note: "Fixture manual payment claim",
    });
    check(
      h.ledger.balances(groupId).find((b) => b.userId === i.fromId)?.cents ===
        -3000,
      "Claim changed ledger",
    );
    const self = await sender.request(
      `/api/payment-attempts/${a.id}/confirm-received`,
      {},
    );
    check(self.response.status === 403, "Sender self-confirmation accepted");
    const receipt = await alex.request(
      `/api/payment-attempts/${a.id}/confirm-received`,
      {},
    );
    check(receipt.response.status === 200, "Recipient confirmation failed");
    console.log(
      `${i.fromId}: $30 ${method}, independently recipient-confirmed in simulation.`,
    );
  }
}
const final = h.ledger.balances(groupId);
check(
  final.every((b) => b.cents === 0),
  "Balances not zero",
);
console.log(
  "PASS: zero balances, conserved value, separate confirmation, no wallet required for manual users.",
);
console.log(final);
h.store.sqlite.close();
