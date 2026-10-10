import { z } from "zod";
import { readFileSync } from "node:fs";
const bool = (fallback: string) =>
  z
    .enum(["true", "false"])
    .default(fallback as "true" | "false")
    .transform((v) => v === "true");
export function readConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const c = z
    .object({
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      HOST: z.string().default("127.0.0.1"),
      DATABASE_URL: z.string().default(".data/tab.sqlite"),
      APP_BASE_URL: z.url().default("http://localhost:5173"),
      DEMO_MODE: bool("true"),
      DEMO_CUSTODIAL_WALLETS: bool("false"),
      SOLANA_CLUSTER: z.literal("devnet").default("devnet"),
      SOLANA_RPC_URL: z.url().default("https://api.devnet.solana.com"),
      TAB_TEST_TOKEN_MINT: z.string().optional(),
      TREASURY_KEY_PATH: z.string().default(".data/treasury.json"),
      TREASURY_SECRET_KEY: z.string().optional(),
      WALLET_ENC_KEY: z.string().optional(),
      SESSION_SECRET: z.string().optional(),
      PHOTON_PROJECT_ID: z.string().optional(),
      PHOTON_PROJECT_SECRET: z.string().optional(),
      PHOTON_ENABLED: bool("false"),
      GEMINI_API_KEY: z.string().optional(),
      GEMINI_API_KEY_FILE: z.string().optional(),
      GEMINI_MODEL: z.string().optional(),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
  if (c.GEMINI_API_KEY_FILE) {
    if (c.GEMINI_API_KEY)
      throw new Error(
        "Configure only one of GEMINI_API_KEY and GEMINI_API_KEY_FILE.",
      );
    try {
      c.GEMINI_API_KEY = readFileSync(c.GEMINI_API_KEY_FILE, "utf8").trim();
      if (!c.GEMINI_API_KEY || /\s/.test(c.GEMINI_API_KEY)) throw new Error();
    } catch {
      throw new Error(
        "Cannot load Gemini credential file. Check its path, permissions and contents.",
      );
    }
  }
  if (c.DEMO_MODE && !["127.0.0.1", "localhost", "::1"].includes(c.HOST))
    throw new Error("Demo identity switching requires a loopback bind.");
  if (!c.DEMO_MODE && (!c.SESSION_SECRET || c.SESSION_SECRET.length < 32))
    throw new Error(
      "SESSION_SECRET must have at least 32 characters outside demo.",
    );
  if (
    c.DEMO_CUSTODIAL_WALLETS &&
    !/^[a-fA-F0-9]{64}$/.test(c.WALLET_ENC_KEY ?? "")
  )
    throw new Error(
      "WALLET_ENC_KEY must contain 32 random bytes in hex for devnet wallets.",
    );
  if (c.GEMINI_API_KEY && !c.GEMINI_MODEL)
    throw new Error("Choose an available Flash model with GEMINI_MODEL.");
  if (c.PHOTON_ENABLED && !(c.PHOTON_PROJECT_ID && c.PHOTON_PROJECT_SECRET))
    throw new Error("Photon requires both project credentials.");
  return c;
}
export type Config = ReturnType<typeof readConfig>;
