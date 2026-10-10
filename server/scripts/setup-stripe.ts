/**
 * Point Stripe at a deployed Tab server (run once per domain, from your laptop):
 *   1. registers the domain for Apple Pay (payment method domain)
 *   2. creates a webhook endpoint at <url>/stripe/webhook for the events Tab handles
 *      and prints its signing secret (put it in STRIPE_WEBHOOK_SECRET on the host)
 *
 *   npm run setup:stripe -- https://your-app.up.railway.app
 *   npm run setup:stripe -- https://your-app.up.railway.app --recreate   (new signing secret)
 */
import Stripe from "stripe";
import { loadConfig } from "../src/config";

const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "account.updated",
  "transfer.created",
];

const [rawUrl] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const recreate = process.argv.includes("--recreate");
const config = loadConfig();
if (!config.stripe) throw new Error("Set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY in server/.env first.");
if (!rawUrl?.startsWith("https://")) {
  console.error("Usage: npm run setup:stripe -- https://your-app.up.railway.app");
  process.exit(1);
}
const base = rawUrl.replace(/\/$/, "");
const domain = new URL(base).hostname;
const stripe = new Stripe(config.stripe.secretKey);
console.log(`Stripe mode: ${config.stripe.secretKey.includes("_test_") ? "test" : "LIVE"}`);

// 1. Apple Pay domain
try {
  const pmd = await stripe.paymentMethodDomains.create({ domain_name: domain });
  console.log(`✅ ${domain} registered for Apple Pay (status: ${pmd.apple_pay?.status ?? "unknown"})`);
} catch (err) {
  console.log(`⚠️  Apple Pay domain: ${(err as Error).message}`);
}

// 2. Webhook endpoint
const url = `${base}/stripe/webhook`;
const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter((e) => e.url === url);
if (existing.length && !recreate) {
  console.log(`ℹ️  A webhook endpoint for ${url} already exists (${existing[0]!.id}).`);
  console.log(`   Stripe only shows its signing secret once. Either copy it from Dashboard → Developers → Webhooks → ${existing[0]!.id} → "Reveal",`);
  console.log(`   or re-run with --recreate to get a new one.`);
} else {
  for (const e of existing) await stripe.webhookEndpoints.del(e.id);
  const endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: EVENTS, description: "Tab server" });
  console.log(`✅ Webhook endpoint created: ${url}`);
  console.log(`\nSet this on Railway as STRIPE_WEBHOOK_SECRET (shown only once):\n\n  ${endpoint.secret}\n`);
}
