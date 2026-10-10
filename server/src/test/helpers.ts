import {
  PublicKey,
  Keypair,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { eq } from "drizzle-orm";
import { openDb } from "../db/client";
import { seed } from "../db/seed";
import { readConfig } from "../config";
import { createApp, type Runtime } from "../api/app";
import { Ledger } from "../domain/ledger";
import { Auth } from "../security/tokens";
import { Payments } from "../payments/service";
import { attempts } from "../db/schema";
import type { PaymentRail, AuthorizedActor } from "../payments/types";
import type { Attempt, Intent } from "../db/schema";
import { verifyTransaction, type ChainExpected } from "../solana/verify";
export function fixture() {
  const sender = Keypair.generate().publicKey,
    recipient = Keypair.generate().publicKey,
    source = Keypair.generate().publicKey,
    destination = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey;
  const expected: ChainExpected = {
    sender: sender.toBase58(),
    recipient: recipient.toBase58(),
    source: source.toBase58(),
    destination: destination.toBase58(),
    mint: mint.toBase58(),
    units: "30000000",
    reference: "attempt-fixture",
    signature: "offline-fixture-signature",
  };
  const balance = (index: number, owner: PublicKey, amount: string) => ({
    accountIndex: index,
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: "0" },
  });
  const tx = {
    slot: 100,
    blockTime: 1,
    meta: {
      err: null,
      preTokenBalances: [
        balance(1, sender, "100000000"),
        balance(2, recipient, "0"),
      ],
      postTokenBalances: [
        balance(1, sender, "70000000"),
        balance(2, recipient, "30000000"),
      ],
    },
    transaction: {
      signatures: [expected.signature],
      message: {
        accountKeys: [
          { pubkey: sender, signer: true, writable: true },
          { pubkey: source, signer: false, writable: true },
          { pubkey: destination, signer: false, writable: true },
        ],
        instructions: [
          {
            programId: TOKEN_PROGRAM_ID,
            parsed: {
              type: "transferChecked",
              info: {
                source: expected.source,
                destination: expected.destination,
                authority: expected.sender,
                mint: expected.mint,
                tokenAmount: { amount: expected.units, decimals: 6 },
              },
            },
          },
          {
            programId: new PublicKey(
              "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            ),
            parsed: expected.reference,
          },
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
  return { tx, expected };
}
/** Offline test-only rail. Never registered by the running application. */
export class FixtureSolana implements PaymentRail {
  calls = 0;
  capability = {
    method: "solana" as const,
    verification: "on_chain" as const,
    canExecuteFromBackend: true,
    requiresRecipientDestination: false,
    userFacingDescription:
      "OFFLINE RPC TEST FIXTURE — not an actual transaction",
    available: true,
  };
  constructor(public ledger: Ledger) {}
  async prepare(i: Intent) {
    return {
      method: "solana" as const,
      recipientLabel: i.toId,
      amountCents: i.amountCents,
      instructionLines: ["OFFLINE TEST ONLY"],
      copyableAmount: "30.00",
      safetyNotice: "No live transaction.",
    };
  }
  async executeAuthorized(a: Attempt, _auth: AuthorizedActor) {
    this.calls++;
    const { tx, expected } = fixture();
    expected.signature = `offline-${a.id}`;
    expected.reference = a.id;
    tx.transaction.signatures[0] = expected.signature;
    const memo = tx.transaction.message.instructions[1]!;
    if ("parsed" in memo) memo.parsed = a.id;
    verifyTransaction(tx, expected, true);
    this.ledger.db
      .update(attempts)
      .set({ status: "submitted", signature: expected.signature })
      .where(eq(attempts.id, a.id))
      .run();
    return this.ledger.applyCredit(a.id, null, "on_chain");
  }
}
export function harness() {
  const store = openDb(":memory:");
  seed(store.db);
  const config = readConfig({ DEMO_MODE: "true" });
  const fixtureRail = new FixtureSolana(new Ledger(store.db));
  const runtime = createApp(store, config, fixtureRail);
  return { ...runtime, fixtureRail };
}
export function client(runtime: Runtime) {
  let cookie = "";
  const request = async (path: string, body?: unknown, method = "POST") => {
    const response = await runtime.app.request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : method,
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-tab-request": "1",
        ...(body instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return {
      response,
      body: (await response.json()) as {
        data: any;
        error?: { code: string; message: string };
      },
    };
  };
  return {
    request,
    login: async (userId: string) => request("/api/dev/login", { userId }),
  };
}
export function groceries(ledger: Ledger) {
  const e = ledger.propose("alex", {
    groupId: "tahoe",
    payerId: "alex",
    description: "Groceries",
    currency: "USD",
    totalCents: 12000,
    participants: ["alex", "ben", "casey", "drew"],
  });
  ledger.review(e.id, "alex", "confirm");
  return e;
}
