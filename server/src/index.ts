import { serve } from "@hono/node-server";
import { createApp } from "./api/app";
import { handleDM } from "./bot/handler";
import { describeFeatures, loadConfig } from "./config";
import { createContext } from "./context";
import { startJobs } from "./jobs";
import { MemoryMessenger } from "./messaging/memory";
import { SpectrumMessenger } from "./messaging/spectrum";
import type { Messenger } from "./messaging/types";

const config = loadConfig();

// Without Photon credentials the server still runs (API, pay page, jobs); outbound DMs are just logged.
const messenger: Messenger = config.photon
  ? new SpectrumMessenger(config.photon)
  : new MemoryMessenger((m) => console.log(`[dm → ${m.to}] ${m.text.replace(/\n/g, "\n    ")}`));

const ctx = createContext(config, messenger);
await messenger.listen((dm) => handleDM(ctx, dm));
const stopJobs = startJobs(ctx);
const server = serve({ fetch: createApp(ctx).fetch, port: config.port });

console.log(`Tab server on http://localhost:${config.port} (public: ${config.publicBaseUrl})\n${describeFeatures(config)}`);
if (config.usingDevSecrets) console.warn("⚠️  Using dev APP_SECRET / WALLET_ENC_KEY. Set real ones before deploying.");

const shutdown = async () => {
  stopJobs();
  await messenger.stop?.();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
