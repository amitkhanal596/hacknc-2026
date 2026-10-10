/**
 * One-time Solana devnet setup: treasury keypair, SOL for fees, and our own
 * "tUSDC" SPL token (6 decimals, treasury is mint authority). Safe to re-run:
 * it reuses TREASURY_SECRET_KEY / USDC_MINT from .env if they're set.
 *
 *   npm run setup:devnet
 */
import "dotenv/config";
import { createMint, getMint } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { TOKEN_DECIMALS } from "../src/payments/solana/chain";

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
if (!rpcUrl.includes("devnet")) {
  console.error(`Refusing to run against ${rpcUrl}: this script is for devnet only.`);
  process.exit(1);
}
const conn = new Connection(rpcUrl, "confirmed");

const treasury = process.env.TREASURY_SECRET_KEY
  ? Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_SECRET_KEY))
  : Keypair.generate();
console.log(`Treasury: ${treasury.publicKey.toBase58()}${process.env.TREASURY_SECRET_KEY ? " (from .env)" : " (new)"}`);

const balance = await conn.getBalance(treasury.publicKey);
console.log(`Balance:  ${balance / LAMPORTS_PER_SOL} SOL`);
if (balance < 0.2 * LAMPORTS_PER_SOL) {
  try {
    console.log("Requesting 1 SOL airdrop…");
    const sig = await conn.requestAirdrop(treasury.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) });
    console.log("Airdrop confirmed.");
  } catch (err) {
    console.error(`\nAirdrop failed (devnet faucet is rate-limited): ${(err as Error).message}`);
    console.error(`Fund it manually at https://faucet.solana.com with address ${treasury.publicKey.toBase58()}, then re-run.`);
    if (!process.env.TREASURY_SECRET_KEY) console.error(`\nSave this first so the address doesn't change:\nTREASURY_SECRET_KEY=${bs58.encode(treasury.secretKey)}`);
    process.exit(1);
  }
}

let mint: PublicKey;
if (process.env.USDC_MINT) {
  mint = new PublicKey(process.env.USDC_MINT);
  const info = await getMint(conn, mint);
  console.log(`tUSDC mint: ${mint.toBase58()} (from .env, ${info.decimals} decimals)`);
} else {
  mint = await createMint(conn, treasury, treasury.publicKey, null, TOKEN_DECIMALS);
  console.log(`Created tUSDC mint: ${mint.toBase58()}`);
}

console.log(`\nAdd these to server/.env:\n`);
console.log(`TREASURY_SECRET_KEY=${bs58.encode(treasury.secretKey)}`);
console.log(`USDC_MINT=${mint.toBase58()}`);
if (!process.env.WALLET_ENC_KEY) console.log(`WALLET_ENC_KEY=${randomBytes(32).toString("hex")}`);
if (!process.env.APP_SECRET) console.log(`APP_SECRET=${randomBytes(32).toString("base64url")}`);
console.log(`\nExplorer: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`);
