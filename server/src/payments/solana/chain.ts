import {
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { centsToTokenUnits } from "../../ledger/money";

export const TOKEN_DECIMALS = 6;
export const STARTING_BALANCE_CENTS = 500_00;

export interface TransferResult {
  signature: string;
  simulated: boolean;
}

/** Where USDC actually moves. `SolanaChain` hits devnet; `SimulatedChain` is used when devnet isn't configured. */
export interface Chain {
  readonly simulated: boolean;
  /** Mint the starting test balance to a new wallet. */
  fundNewWallet(pubkey: string): Promise<void>;
  transfer(from: Keypair, toPubkey: string, cents: number): Promise<TransferResult>;
  balanceCents(pubkey: string): Promise<number | undefined>;
  explorerUrl(signature: string): string | undefined;
}

export class SolanaChain implements Chain {
  readonly simulated = false;
  private conn: Connection;
  private treasury: Keypair;
  private mint: PublicKey;

  constructor(opts: { rpcUrl: string; treasurySecretKey: string; usdcMint: string }) {
    this.conn = new Connection(opts.rpcUrl, "confirmed");
    this.treasury = Keypair.fromSecretKey(bs58.decode(opts.treasurySecretKey));
    this.mint = new PublicKey(opts.usdcMint);
  }

  async fundNewWallet(pubkey: string): Promise<void> {
    // The treasury pays for the token account and is the mint authority for our devnet tUSDC.
    const ata = await getOrCreateAssociatedTokenAccount(this.conn, this.treasury, this.mint, new PublicKey(pubkey));
    await mintTo(this.conn, this.treasury, this.mint, ata.address, this.treasury, centsToTokenUnits(STARTING_BALANCE_CENTS));
  }

  async transfer(from: Keypair, toPubkey: string, cents: number): Promise<TransferResult> {
    const fromAta = getAssociatedTokenAddressSync(this.mint, from.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(this.conn, this.treasury, this.mint, new PublicKey(toPubkey));
    const tx = new Transaction().add(
      createTransferCheckedInstruction(fromAta, this.mint, toAta.address, from.publicKey, centsToTokenUnits(cents), TOKEN_DECIMALS),
    );
    // Treasury pays the network fee so user wallets never need SOL.
    tx.feePayer = this.treasury.publicKey;
    const signature = await sendAndConfirmTransaction(this.conn, tx, [this.treasury, from], { commitment: "confirmed" });
    return { signature, simulated: false };
  }

  async balanceCents(pubkey: string): Promise<number | undefined> {
    try {
      const acct = await getAccount(this.conn, getAssociatedTokenAddressSync(this.mint, new PublicKey(pubkey)));
      return Number(acct.amount / 10_000n);
    } catch {
      return undefined;
    }
  }

  explorerUrl(signature: string): string {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  }
}

/** Keeps balances in memory and returns fake signatures. Clearly labeled as simulated in messages. */
export class SimulatedChain implements Chain {
  readonly simulated = true;
  private balances = new Map<string, number>();

  async fundNewWallet(pubkey: string): Promise<void> {
    this.balances.set(pubkey, (this.balances.get(pubkey) ?? 0) + STARTING_BALANCE_CENTS);
  }

  async transfer(from: Keypair, toPubkey: string, cents: number): Promise<TransferResult> {
    const fromKey = from.publicKey.toBase58();
    const balance = this.balances.get(fromKey) ?? STARTING_BALANCE_CENTS;
    if (balance < cents) throw new Error("insufficient tUSDC balance");
    this.balances.set(fromKey, balance - cents);
    this.balances.set(toPubkey, (this.balances.get(toPubkey) ?? STARTING_BALANCE_CENTS) + cents);
    return { signature: `sim_${bs58.encode(randomBytes(32))}`, simulated: true };
  }

  async balanceCents(pubkey: string): Promise<number | undefined> {
    return this.balances.get(pubkey) ?? STARTING_BALANCE_CENTS;
  }

  explorerUrl(): undefined {
    return undefined;
  }
}
