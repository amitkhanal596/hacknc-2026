import { HeuristicExtractor } from "../src/ai/heuristic";
import { FAKE_RECEIPT_MIME, type ImageExtraction } from "../src/ai/types";
import { handleDM } from "../src/bot/handler";
import { loadConfig } from "../src/config";
import { createContext, type Ctx } from "../src/context";
import { openDb } from "../src/db/client";
import { MemoryMessenger } from "../src/messaging/memory";
import type { InboundImage } from "../src/messaging/types";
import { SimulatedChain } from "../src/payments/solana/chain";

export const PHONES = {
  amit: "+19195550001",
  jake: "+19195550002",
  priya: "+19195550003",
  sam: "+19195550004",
} as const;
export type Person = keyof typeof PHONES;

/** A fully wired bot with an in-memory DB, inbox, regex extractor, simulated chain, and a controllable clock. */
export function makeBot(envOverrides: Record<string, string> = {}) {
  const config = loadConfig({ DEMO_MODE: "false", DATABASE_PATH: ":memory:", ...envOverrides } as NodeJS.ProcessEnv);
  const messenger = new MemoryMessenger();
  let clock = Date.parse("2026-10-11T15:00:00Z");
  const ctx: Ctx = createContext(config, messenger, {
    db: openDb(":memory:"),
    extractor: new HeuristicExtractor(),
    chain: new SimulatedChain(),
    stripe: undefined,
    now: () => clock,
  });
  void messenger.listen((dm) => handleDM(ctx, dm));

  return {
    ctx,
    messenger,
    advance(ms: number) {
      clock += ms;
    },
    /** Person texts the bot; returns what the bot sent back to them (and clears it). */
    async say(who: Person, text: string, images: InboundImage[] = []): Promise<string> {
      messenger.clearInbox(PHONES[who]);
      await messenger.receive(PHONES[who], text, images);
      return messenger.inbox(PHONES[who], true).join("\n---\n");
    },
    /** Everything the bot has sent this person since the last read (and clears it). */
    read(who: Person): string {
      return messenger.inbox(PHONES[who], true).join("\n---\n");
    },
  };
}

export function fakeReceipt(r: Partial<ImageExtraction>, name = "receipt.jpg"): InboundImage {
  const body = Buffer.from(JSON.stringify(r));
  return { name, mimeType: FAKE_RECEIPT_MIME, read: async () => body };
}
