import { createExtractor, type Extractor } from "./ai";
import type { Config } from "./config";
import { openDb, type DB } from "./db/client";
import { registerPhotonUser } from "./messaging/photon-users";
import type { Messenger } from "./messaging/types";
import { SimulatedChain, SolanaChain, type Chain } from "./payments/solana/chain";
import { StripeRail } from "./payments/stripe/rail";

/** Everything a handler needs. Passed explicitly so tests can swap any piece. */
export interface Ctx {
  config: Config;
  db: DB;
  messenger: Messenger;
  extractor: Extractor;
  chain: Chain;
  stripe?: StripeRail;
  /** Registers a phone with the messaging provider (Photon shared lines). Undefined when not needed. */
  registerMessagingUser?: (phone: string, firstName?: string | null) => Promise<{ assignedPhoneNumber: string }>;
  now: () => number;
}

export function createContext(config: Config, messenger: Messenger, overrides: Partial<Ctx> = {}): Ctx {
  return {
    config,
    messenger,
    db: overrides.db ?? openDb(config.databasePath),
    extractor: overrides.extractor ?? createExtractor(config),
    chain: overrides.chain ?? (config.solana ? new SolanaChain(config.solana) : new SimulatedChain()),
    stripe:
      "stripe" in overrides
        ? overrides.stripe
        : config.stripe
          ? new StripeRail({ ...config.stripe, publicBaseUrl: config.publicBaseUrl })
          : undefined,
    registerMessagingUser:
      "registerMessagingUser" in overrides
        ? overrides.registerMessagingUser
        : config.photon
          ? (phone, firstName) => registerPhotonUser(config.photon!, phone, firstName)
          : undefined,
    now: overrides.now ?? Date.now,
  };
}

/** Timing knobs: demo mode shrinks everything so it can be shown live. */
export function timings(config: Config) {
  const min = 60_000;
  return config.demoMode
    ? { autoApproveMs: 2 * min, reminderMs: 2 * min, jobTickMs: 30_000, promptTtlMs: 60 * min }
    : { autoApproveMs: 24 * 60 * min, reminderMs: 60 * min, jobTickMs: 5 * min, promptTtlMs: 24 * 60 * min };
}
