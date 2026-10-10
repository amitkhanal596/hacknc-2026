import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { createMint, getMint } from "@solana/spl-token";
import { readConfig } from "../server/src/config";
import { treasury } from "../server/src/solana/wallets";
const config = readConfig();
if (config.SOLANA_CLUSTER !== "devnet") throw new Error("Devnet only.");
mkdirSync(".data", { recursive: true, mode: 0o700 });
if (!config.TREASURY_SECRET_KEY && !existsSync(config.TREASURY_KEY_PATH)) {
  writeFileSync(
    config.TREASURY_KEY_PATH,
    JSON.stringify([...Keypair.generate().secretKey]),
    { mode: 0o600, flag: "wx" },
  );
  chmodSync(config.TREASURY_KEY_PATH, 0o600);
}
const payer = treasury(config);
const rpc = new Connection(config.SOLANA_RPC_URL, {
  commitment: "finalized",
  disableRetryOnRateLimit: true,
});
console.log("Devnet treasury public address:", payer.publicKey.toBase58());
try {
  if (
    (await rpc.getGenesisHash()) !==
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw new Error("RPC is not devnet.");
  const balance = await rpc.getBalance(payer.publicKey);
  if (balance < LAMPORTS_PER_SOL / 20) {
    console.log(
      "Requesting 1 devnet SOL for test account creation and sponsored fees.",
    );
    const signature = await rpc.requestAirdrop(
      payer.publicKey,
      LAMPORTS_PER_SOL,
    );
    const latest = await rpc.getLatestBlockhash();
    await rpc.confirmTransaction({ signature, ...latest }, "finalized");
  }
  const saved = existsSync(".data/devnet.json")
    ? (JSON.parse(readFileSync(".data/devnet.json", "utf8")) as {
        mint: string;
      })
    : null;
  let mint: PublicKey;
  if (config.TAB_TEST_TOKEN_MINT || saved)
    mint = new PublicKey(config.TAB_TEST_TOKEN_MINT || saved!.mint);
  else {
    // Preserve the mint key before creation; retries reuse it instead of creating another mint.
    const mintPath = ".data/mint-key.json";
    if (!existsSync(mintPath))
      writeFileSync(
        mintPath,
        JSON.stringify([...Keypair.generate().secretKey]),
        { mode: 0o600, flag: "wx" },
      );
    const mintKey = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(mintPath, "utf8")) as number[]),
    );
    const existing = await rpc.getAccountInfo(mintKey.publicKey);
    mint = existing
      ? mintKey.publicKey
      : await createMint(rpc, payer, payer.publicKey, null, 6, mintKey, {
          commitment: "finalized",
        });
  }
  const account = await getMint(rpc, mint);
  if (account.decimals !== 6 || !account.mintAuthority?.equals(payer.publicKey))
    throw new Error(
      "Configured mint must have six decimals and this treasury as mint authority.",
    );
  writeFileSync(
    ".data/devnet.json",
    JSON.stringify(
      {
        mint: mint.toBase58(),
        name: "TAB Test USD",
        symbol: "tUSD",
        decimals: 6,
        network: "devnet",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log("TAB Test USD (tUSD) mint:", mint.toBase58());
  console.log(
    "Stable mint saved to .data/devnet.json. No real value. Enable DEMO_CUSTODIAL_WALLETS and set WALLET_ENC_KEY; restart the server.",
  );
} catch (error) {
  console.error(
    "Devnet setup did not complete. RPC/faucet access or devnet SOL funding is required.",
  );
  console.error(
    error instanceof Error &&
      /429|airdrop|fetch|timeout|403/i.test(error.message)
      ? "RPC or faucet request failed / rate limited."
      : "Check configured RPC, mint authority and treasury funding.",
  );
  console.error(
    "Fund the public treasury address with devnet SOL, then rerun bun run setup:devnet. No live integration success is claimed.",
  );
  process.exitCode = 1;
}
