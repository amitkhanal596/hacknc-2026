/**
 * One-time Solana devnet setup: treasury keypair, SOL for fees, and our own
 * "tUSDC" SPL token (6 decimals, treasury is mint authority). Writes the
 * results straight into server/.env (secrets are never printed). Safe to re-run:
 * it reuses TREASURY_SECRET_KEY / USDC_MINT if they're already set.
 *
 *   npm run setup:devnet
 */
import "dotenv/config";
import { createMint, getMint } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TOKEN_DECIMALS } from "../src/payments/solana/chain";

const ENV_FILE = new URL("../.env", import.meta.url);

function writeEnv(updates: Record<string, string>) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
    process.env[key] = value;
    console.log(`  wrote ${key} to .env`);
  }
  writeFileSync(ENV_FILE, text);
}

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
if (!rpcUrl.includes("devnet")) {
  console.error(`Refusing to run against ${rpcUrl}: this script is for devnet only.`);
  process.exit(1);
}
const conn = new Connection(rpcUrl, "confirmed");

// Secrets the server needs regardless of Solana.
const missing: Record<string, string> = {};
if (!process.env.WALLET_ENC_KEY) missing.WALLET_ENC_KEY = randomBytes(32).toString("hex");
if (!process.env.APP_SECRET) missing.APP_SECRET = randomBytes(32).toString("base64url");

let treasury: Keypair;
if (process.env.TREASURY_SECRET_KEY) {
  treasury = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_SECRET_KEY));
  console.log(`Treasury: ${treasury.publicKey.toBase58()} (from .env)`);
} else {
  treasury = Keypair.generate();
  missing.TREASURY_SECRET_KEY = bs58.encode(treasury.secretKey);
  console.log(`Treasury: ${treasury.publicKey.toBase58()} (new)`);
}
if (Object.keys(missing).length) writeEnv(missing);

const balance = await conn.getBalance(treasury.publicKey);
console.log(`Balance:  ${balance / LAMPORTS_PER_SOL} SOL`);
if (balance < 0.05 * LAMPORTS_PER_SOL) {
  try {
    console.log("Requesting 1 SOL airdrop…");
    const sig = await conn.requestAirdrop(treasury.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) });
    console.log("Airdrop confirmed.");
  } catch (err) {
    console.error(`\nThe devnet airdrop is rate-limited right now (${(err as Error).message.slice(0, 60)}…).`);
    console.error(`Get free devnet SOL in your browser:`);
    console.error(`  1. Open https://faucet.solana.com (network: devnet)`);
    console.error(`  2. Paste this address: ${treasury.publicKey.toBase58()}`);
    console.error(`  3. Request 1 SOL (or 0.5), then run npm run setup:devnet again.`);
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
  writeEnv({ USDC_MINT: mint.toBase58() });
}

console.log(`\n✅ Devnet is ready. Restart the server to switch from simulated to real USDC payments.`);
console.log(`Treasury: https://explorer.solana.com/address/${treasury.publicKey.toBase58()}?cluster=devnet`);
console.log(`tUSDC:    https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`);
