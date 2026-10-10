import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getMint,
  mintTo,
} from "@solana/spl-token";
import bs58 from "bs58";
import { eq } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import type { Config } from "../config";
import type { Attempt, Destination, Intent } from "../db/schema";
import * as s from "../db/schema";
import { Ledger } from "../domain/ledger";
import { ensure, formatMoney, tokenUnits } from "../domain/money";
import type { AuthorizedActor, PaymentRail } from "./types";
import { decrypt, encrypt, treasury } from "../solana/wallets";
import { verifyTransaction, type ChainExpected } from "../solana/verify";
export class SolanaRail implements PaymentRail {
  readonly capability;
  readonly connection: Connection;
  readonly mintAddress?: string;
  private provisionLocks = new Map<string, Promise<string>>();
  private reconcileLocks = new Set<string>();
  constructor(
    public ledger: Ledger,
    public config: Config,
  ) {
    this.mintAddress =
      config.TAB_TEST_TOKEN_MINT ||
      (existsSync(".data/devnet.json")
        ? (
            JSON.parse(readFileSync(".data/devnet.json", "utf8")) as {
              mint: string;
            }
          ).mint
        : undefined);
    this.connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: "finalized",
      disableRetryOnRateLimit: true,
    });
    this.capability = {
      method: "solana" as const,
      verification: "on_chain" as const,
      canExecuteFromBackend: true,
      requiresRecipientDestination: true,
      userFacingDescription:
        "Real finalized Solana devnet transfer. TAB Test USD (tUSD), no real value.",
      available: !!(
        config.DEMO_CUSTODIAL_WALLETS &&
        config.WALLET_ENC_KEY &&
        this.mintAddress &&
        (config.TREASURY_SECRET_KEY || existsSync(config.TREASURY_KEY_PATH))
      ),
    };
  }
  async assertDevnet() {
    ensure(
      (await this.connection.getGenesisHash()) ===
        "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      "NETWORK",
      "RPC is not Solana devnet.",
    );
    const mint = await getMint(
      this.connection,
      new PublicKey(this.mintAddress!),
    );
    ensure(
      mint.decimals === 6 &&
        mint.mintAuthority?.equals(treasury(this.config).publicKey),
      "MINT",
      "Expected treasury-owned six-decimal TAB test mint.",
    );
  }
  wallet(userId: string) {
    return this.ledger.db
      .select()
      .from(s.wallets)
      .where(eq(s.wallets.userId, userId))
      .get();
  }
  async provision(userId: string): Promise<string> {
    ensure(
      this.capability.available,
      "RAIL_UNAVAILABLE",
      "Devnet is not configured.",
      503,
    );
    const existing = this.provisionLocks.get(userId);
    if (existing) return existing;
    const task = this.provisionInner(userId);
    this.provisionLocks.set(userId, task);
    try {
      return await task;
    } finally {
      this.provisionLocks.delete(userId);
    }
  }
  private async provisionInner(userId: string) {
    await this.assertDevnet();
    let wallet = this.wallet(userId);
    if (!wallet) {
      const key = Keypair.generate();
      this.ledger.db
        .insert(s.wallets)
        .values({
          userId,
          address: key.publicKey.toBase58(),
          encryptedSecret: encrypt(key.secretKey, this.config.WALLET_ENC_KEY!),
          mint: this.mintAddress!,
        })
        .run();
      wallet = this.wallet(userId)!;
    }
    ensure(
      wallet.mint === this.mintAddress,
      "MINT_CHANGED",
      "Existing wallet belongs to another demo mint.",
    );
    const payer = treasury(this.config);
    const ata = await getOrCreateAssociatedTokenAccount(
      this.connection,
      payer,
      new PublicKey(this.mintAddress!),
      new PublicKey(wallet.address),
    );
    // Test-only top-up. No user-provided address/mint. Each call is rate limited at the API.
    if (ata.amount === 0n)
      await mintTo(
        this.connection,
        payer,
        new PublicKey(this.mintAddress!),
        ata.address,
        payer,
        1_000_000_000n,
        [],
        { commitment: "finalized" },
      );
    return wallet.address;
  }
  async prepare(intent: Intent, _destination: Destination | null) {
    ensure(
      this.capability.available,
      "RAIL_UNAVAILABLE",
      "Solana demo unavailable.",
      503,
    );
    ensure(
      this.wallet(intent.toId),
      "DESTINATION_REQUIRED",
      "Recipient must enable their devnet test wallet in Payment details first.",
      409,
    );
    ensure(
      this.wallet(intent.fromId),
      "WALLET_REQUIRED",
      "Enable your devnet test wallet in Payment details first.",
      409,
    );
    return {
      method: "solana" as const,
      recipientLabel: intent.toId,
      amountCents: intent.amountCents,
      copyableRecipient: this.wallet(intent.toId)!.address,
      copyableAmount: formatMoney(intent.amountCents).slice(1),
      instructionLines: [
        "Approve this exact test payment on this authenticated page.",
        "The treasury sponsors fees; the backend signs only a devnet tUSD transfer.",
        "The balance changes only after the exact transaction is finalized and verified.",
      ],
      safetyNotice:
        "TAB Test USD (tUSD) — Solana devnet test token / no real value.",
    };
  }
  async executeAuthorized(
    attempt: Attempt,
    actor: AuthorizedActor,
  ): Promise<Attempt> {
    const i = this.ledger.intent(attempt.intentId);
    ensure(
      attempt.status === "submitting" &&
        actor.userId === i.fromId &&
        actor.attemptId === attempt.id &&
        actor.amountCents === i.amountCents &&
        actor.recipientId === i.toId,
      "AUTHORIZATION",
      "Invalid authorized actor.",
      403,
    );
    try {
      await this.assertDevnet();
      const from = this.wallet(i.fromId),
        to = this.wallet(i.toId);
      ensure(
        from &&
          to &&
          from.mint === this.mintAddress &&
          to.mint === this.mintAddress,
        "WALLET",
        "Both devnet wallets must be enabled.",
      );
      const sender = Keypair.fromSecretKey(
        decrypt(from.encryptedSecret, this.config.WALLET_ENC_KEY!),
      );
      const payer = treasury(this.config),
        mint = new PublicKey(this.mintAddress!);
      const source = await getAssociatedTokenAddress(mint, sender.publicKey),
        destination = await getAssociatedTokenAddress(
          mint,
          new PublicKey(to.address),
        );
      const block = await this.connection.getLatestBlockhash("finalized");
      const tx = new Transaction({ ...block, feePayer: payer.publicKey }).add(
        createTransferCheckedInstruction(
          source,
          mint,
          destination,
          sender.publicKey,
          tokenUnits(i.amountCents),
          6,
        ),
        new TransactionInstruction({
          programId: new PublicKey(
            "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          ),
          keys: [],
          data: Buffer.from(attempt.id),
        }),
      );
      tx.sign(payer, sender);
      const signature = bs58.encode(tx.signature!);
      const raw = tx.serialize().toString("base64");
      const expected: ChainExpected = {
        source: source.toBase58(),
        destination: destination.toBase58(),
        sender: from.address,
        recipient: to.address,
        mint: this.mintAddress!,
        units: tokenUnits(i.amountCents).toString(),
        reference: attempt.id,
        signature,
      };
      this.ledger.db.transaction(() => {
        this.ledger.db
          .update(s.attempts)
          .set({
            signature,
            rawTransaction: raw,
            lastValidBlockHeight: block.lastValidBlockHeight,
            chainExpected: JSON.stringify(expected),
            network: "devnet",
            mint: this.mintAddress,
            status: "submitted",
          })
          .where(eq(s.attempts.id, attempt.id))
          .run();
        this.ledger.log(
          i.groupId,
          actor.userId,
          "transaction_persisted",
          attempt.id,
          { signature },
        );
      });
      // Persist first. A timeout can never cause a new signed transfer.
      await this.connection.sendRawTransaction(Buffer.from(raw, "base64"), {
        maxRetries: 2,
      });
      await this.connection.confirmTransaction(
        { ...block, signature },
        "finalized",
      );
      await this.reconcile(attempt.id);
    } catch {
      const current = this.ledger.attempt(attempt.id);
      this.ledger.db
        .update(s.attempts)
        .set({
          status: current.signature ? "submitted" : "failed",
          failure: current.signature
            ? "RPC outcome uncertain. Reconciliation will check the existing signature; no replacement is issued."
            : "Devnet preparation failed before broadcast. Check RPC, mint, wallets and treasury funding.",
        })
        .where(eq(s.attempts.id, attempt.id))
        .run();
    }
    return this.ledger.attempt(attempt.id);
  }
  async verify(attempt: Attempt) {
    ensure(
      attempt.signature && attempt.chainExpected,
      "CHAIN_REFERENCE",
      "No submitted transaction.",
    );
    const status = (
      await this.connection.getSignatureStatuses([attempt.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (!status || status.confirmationStatus !== "finalized") return false;
    ensure(!status.err, "CHAIN_FAILED", "Transaction failed on chain.");
    const tx = await this.connection.getParsedTransaction(attempt.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    return verifyTransaction(
      tx,
      JSON.parse(attempt.chainExpected) as ChainExpected,
      true,
    );
  }
  async reconcile(id: string) {
    if (this.reconcileLocks.has(id)) return this.ledger.attempt(id);
    this.reconcileLocks.add(id);
    try {
      const a = this.ledger.attempt(id);
      if (a.status !== "submitted" || !a.signature) return a;
      const status = (
        await this.connection.getSignatureStatuses([a.signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (status?.err && status.confirmationStatus === "finalized") {
        this.ledger.db
          .update(s.attempts)
          .set({
            status: "failed",
            failure:
              "Finalized transaction failed. No settlement credit applied.",
          })
          .where(eq(s.attempts.id, id))
          .run();
      } else if (await this.verify(a))
        this.ledger.applyCredit(id, null, "on_chain");
      else if (
        !status &&
        a.rawTransaction &&
        (await this.connection.getBlockHeight("finalized")) <=
          (a.lastValidBlockHeight ?? 0)
      )
        await this.connection.sendRawTransaction(
          Buffer.from(a.rawTransaction, "base64"),
          { maxRetries: 0 },
        );
      // Expired unseen signatures deliberately remain locked: absence from one RPC is not proof of nonpayment.
      return this.ledger.attempt(id);
    } finally {
      this.reconcileLocks.delete(id);
    }
  }
}
