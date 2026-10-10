import { serveStatic } from "hono/bun";
import { openDb } from "./db/client";
import { readConfig } from "./config";
import { seed } from "./db/seed";
import { createApp } from "./api/app";
import { recoverInterrupted, reconcile, flushOutbox } from "./jobs/reconcile";
const config = readConfig(),
  store = openDb(config.DATABASE_URL);
if (config.DEMO_MODE) seed(store.db);
const runtime = createApp(store, config);
recoverInterrupted(runtime);
runtime.app.get("/assets/*", serveStatic({ root: "./dist" }));
runtime.app.get("*", async (c) => {
  if (c.req.path.startsWith("/api/"))
    return c.json(
      { error: { code: "NOT_FOUND", message: "Route not found." } },
      404,
    );
  const file = Bun.file("dist/index.html");
  if (await file.exists()) return c.html(await file.text());
  return c.text(
    "Tab API is ready. Start Vite with bun run dev, or run bun run build first.",
  );
});
const server = Bun.serve({
  hostname: config.HOST,
  port: config.PORT,
  fetch: runtime.app.fetch,
  idleTimeout: 120,
  maxRequestBodySize: 6 * 1024 * 1024,
});
console.log(
  `Tab API: http://${config.HOST}:${server.port} · ${config.DEMO_MODE ? "LOCAL DEMO" : "authenticated Photon mode"}`,
);
console.log(
  `AI: ${runtime.extractor.mode} · Solana: ${runtime.solana.capability.available ? "devnet configured (network not yet verified)" : "unavailable"} · no real-value payments`,
);
let photon:
  | Awaited<ReturnType<typeof import("./messaging/photon").startPhoton>>
  | undefined;
if (config.PHOTON_ENABLED) {
  try {
    const { startPhoton } = await import("./messaging/photon");
    photon = await startPhoton(runtime);
    console.log(
      "Photon SDK initialized; listening for private messages. Send ping to verify delivery.",
    );
    photon.loop.catch(() =>
      console.error("Photon message stream ended; real DM login disabled."),
    );
  } catch {
    runtime.setPhotonState("unavailable");
    console.error(
      "Photon connection unavailable. No live messaging success claimed.",
    );
  }
}
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await reconcile(runtime);
    await flushOutbox(runtime, photon?.send);
  } finally {
    running = false;
  }
}, 15000);
const stop = async () => {
  clearInterval(timer);
  await photon?.stop();
  server.stop(true);
  store.sqlite.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
