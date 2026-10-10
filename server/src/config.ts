import "dotenv/config";
import { z } from "zod";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = z.preprocess(blankToUndefined, z.string().optional());

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  DATABASE_PATH: z.string().default("./data/tab.db"),
  DEMO_MODE: z.preprocess((v) => v === undefined || v === "" ? "true" : v, z.string()).transform((v) => v === "true" || v === "1"),

  PHOTON_PROJECT_ID: optional,
  PHOTON_PROJECT_SECRET: optional,
  BOT_HANDLE: z.string().default("+15555550100"),

  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().default("gemini-3.8-flash,gemini-3.5-flash,gemini-2.5-flash,gemini-2.5-flash-lite")),

  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"),
  TREASURY_SECRET_KEY: optional,
  USDC_MINT: optional,
  WALLET_ENC_KEY: optional,

  STRIPE_SECRET_KEY: optional,
  STRIPE_PUBLISHABLE_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,

  APP_SECRET: optional,
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = envSchema.parse(env);
  const devSecret = "tab-dev-secret-do-not-use-in-prod";
  return {
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    databasePath: e.DATABASE_PATH,
    demoMode: e.DEMO_MODE,
    botHandle: e.BOT_HANDLE,
    photon: e.PHOTON_PROJECT_ID && e.PHOTON_PROJECT_SECRET
      ? { projectId: e.PHOTON_PROJECT_ID, projectSecret: e.PHOTON_PROJECT_SECRET }
      : undefined,
    gemini: e.GEMINI_API_KEY ? { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL } : undefined,
    solana: e.TREASURY_SECRET_KEY && e.USDC_MINT
      ? { rpcUrl: e.SOLANA_RPC_URL, treasurySecretKey: e.TREASURY_SECRET_KEY, usdcMint: e.USDC_MINT }
      : undefined,
    stripe: e.STRIPE_SECRET_KEY && e.STRIPE_PUBLISHABLE_KEY
      ? { secretKey: e.STRIPE_SECRET_KEY, publishableKey: e.STRIPE_PUBLISHABLE_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET }
      : undefined,
    // 32-byte key for AES-256-GCM wallet encryption. The dev fallback is derived from a constant.
    walletEncKey: e.WALLET_ENC_KEY ?? "0".repeat(63) + "1",
    appSecret: e.APP_SECRET ?? devSecret,
    usingDevSecrets: !e.APP_SECRET || !e.WALLET_ENC_KEY,
  };
}

export function describeFeatures(config: Config): string {
  const on = (b: unknown) => (b ? "on " : "off");
  return [
    `  Spectrum iMessage: ${on(config.photon)}${config.photon ? "" : " (use npm run sim)"}`,
    `  Gemini:            ${on(config.gemini)}${config.gemini ? ` (${config.gemini.model.replace(/,/g, " → ")})` : " (regex fallback)"}`,
    `  Solana devnet:     ${on(config.solana)}${config.solana ? "" : " (simulated payments)"}`,
    `  Stripe Apple Pay:  ${on(config.stripe)}`,
    `  Demo mode:         ${on(config.demoMode)}`,
  ].join("\n");
}
