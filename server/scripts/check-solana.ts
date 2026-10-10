/**
 * Live Solana devnet check: makes two wallets the way the bot does, funds them
 * with starting tUSDC, sends $12.34 from one to the other with the treasury
 * paying fees, and verifies balances on-chain.
 *
 *   npm run check:solana
 */
import { Connection, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config";
import { SolanaChain, STARTING_BALANCE_CENTS } from "../src/payments/solana/chain";
import { loadKeypair, newWallet } from "../src/payments/solana/wallets";

const config = loadConfig();
if (!config.solana) throw new Error("Run npm run setup:devnet first (needs TREASURY_SECRET_KEY and USDC_MINT).");
const chain = new SolanaChain(config.solana);
const conn = new Connection(config.solana.rpcUrl, "confirmed");
const treasury = Keypair.fromSecretKey(bs58.decode(config.solana.treasurySecretKey));
const ok = (s: string) => console.log(`✅ ${s}`);

const solBefore = await conn.getBalance(treasury.publicKey);
ok(`treasury has ${(solBefore / LAMPORTS_PER_SOL).toFixed(4)} SOL for fees`);

const a = newWallet(config.walletEncKey);
const b = newWallet(config.walletEncKey);
ok(`created wallets ${a.pubkey.slice(0, 8)}… and ${b.pubkey.slice(0, 8)}… (secrets AES-encrypted)`);

await chain.fundNewWallet(a.pubkey);
await chain.fundNewWallet(b.pubkey);
const aStart = await chain.balanceCents(a.pubkey);
if (aStart !== STARTING_BALANCE_CENTS) throw new Error(`expected ${STARTING_BALANCE_CENTS}¢ starting balance, got ${aStart}`);
ok(`minted $${(STARTING_BALANCE_CENTS / 100).toFixed(2)} tUSDC to each`);

const t0 = Date.now();
const { signature } = await chain.transfer(loadKeypair(a.secretEnc, config.walletEncKey), b.pubkey, 1234);
ok(`sent $12.34 in ${Date.now() - t0}ms: ${chain.explorerUrl(signature)}`);

const [aEnd, bEnd] = [await chain.balanceCents(a.pubkey), await chain.balanceCents(b.pubkey)];
if (aEnd !== STARTING_BALANCE_CENTS - 1234 || bEnd !== STARTING_BALANCE_CENTS + 1234) throw new Error(`balances wrong: ${aEnd} / ${bEnd}`);
ok(`balances on-chain: sender $${(aEnd! / 100).toFixed(2)}, receiver $${(bEnd! / 100).toFixed(2)}`);

const solAfter = await conn.getBalance(treasury.publicKey);
const spent = (solBefore - solAfter) / LAMPORTS_PER_SOL;
ok(`treasury paid ${spent.toFixed(5)} SOL total (≈ ${Math.floor((solAfter / LAMPORTS_PER_SOL) / (spent / 2))} more new users at this rate)`);
console.log("\nAll live Solana checks passed.");
