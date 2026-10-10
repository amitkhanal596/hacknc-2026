/**
 * One command to test Tab from your iPhone:
 *   1. opens a public HTTPS tunnel to this laptop (cloudflared)
 *   2. registers that domain with Stripe so the Apple Pay button can show
 *   3. forwards Stripe webhooks to the server (stripe listen)
 *   4. starts the server with PUBLIC_BASE_URL set to the tunnel
 *
 *   npm run phone
 *
 * Needs: brew install cloudflared stripe/stripe-cli/stripe
 */
import { spawn, type ChildProcess } from "node:child_process";
import Stripe from "stripe";
import { loadConfig } from "../src/config";

const config = loadConfig();
const PORT = config.port;
const children: ChildProcess[] = [];
const tag = (name: string, color: number) => (line: string) => line.trim() && console.log(`\x1b[${color}m[${name}]\x1b[0m ${line}`);

function run(name: string, color: number, cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const log = tag(name, color);
  for (const stream of [child.stdout!, child.stderr!]) {
    let buf = "";
    stream.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) if (!/DeprecationWarning|trace-deprecation/.test(l)) log(l.replace(/whsec_[A-Za-z0-9]+/g, "whsec_…"));
    });
  }
  child.on("exit", (code) => log(`exited (${code})`));
  return child;
}

function shutdown() {
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 1. Tunnel
console.log("Opening an HTTPS tunnel with cloudflared…");
const tunnel = run("tunnel", 35, "cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`]);
const publicUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("cloudflared didn't print a URL within 30s")), 30_000);
  const onData = (d: Buffer) => {
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  };
  tunnel.stdout!.on("data", onData);
  tunnel.stderr!.on("data", onData);
}).catch((err) => {
  console.error(`❌ ${(err as Error).message}. Is cloudflared installed? (brew install cloudflared)`);
  shutdown();
  throw err;
});
const domain = new URL(publicUrl).hostname;

// 2. Register the domain for Apple Pay
if (config.stripe) {
  try {
    const stripe = new Stripe(config.stripe.secretKey);
    const pmd = await stripe.paymentMethodDomains.create({ domain_name: domain });
    const ap = pmd.apple_pay?.status_details?.error_message;
    console.log(`✅ Registered ${domain} with Stripe (Apple Pay: ${pmd.apple_pay?.status ?? "unknown"}${ap ? `, ${ap}` : ""})`);
  } catch (err) {
    console.warn(`⚠️  Couldn't register ${domain} for Apple Pay: ${(err as Error).message}`);
  }

  // 3. Webhooks
  run("stripe", 33, "stripe", [
    "listen",
    "--api-key",
    config.stripe.secretKey,
    "--events",
    "payment_intent.succeeded,payment_intent.payment_failed,account.updated,transfer.created",
    "--forward-to",
    `localhost:${PORT}/stripe/webhook`,
  ]);
}

// 4. Server
run("server", 36, "npx", ["tsx", "src/index.ts"], { ...process.env, PUBLIC_BASE_URL: publicUrl, PORT: String(PORT) });

setTimeout(() => {
  console.log(`
\x1b[1mReady for your iPhone\x1b[0m
  Public URL:   ${publicUrl}
  Health check: ${publicUrl}/health  (open it in Safari on your phone)
  ${config.photon ? `First time? Register your phone: npm run photon:register -- +1YOURNUMBER YourName  (prints the number to text)` : "Photon isn't configured: DMs are only printed here."}
  Friends join from the invite link the bot sends after "new trip <name>" (${publicUrl}/j/CODE).
  Pay links in settle-up texts now point at ${domain}, so they open on your phone.
  Ctrl+C stops everything. The tunnel URL changes each run (pay links from older runs stop working).
`);
}, 4000);
