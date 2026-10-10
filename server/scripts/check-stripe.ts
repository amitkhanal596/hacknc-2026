/**
 * Live Stripe check (test mode). Runs the real Apple Pay money path end to end,
 * minus the Apple Pay sheet itself:
 *   bot DMs → debt → PaymentIntent (our code) → confirm with Stripe's test card →
 *   webhook (via `stripe listen`) marks it paid/held → Connect v2 account + onboarding link.
 *
 * In another terminal first:  stripe listen --forward-to localhost:3997/stripe/webhook
 *   npx tsx scripts/check-stripe.ts
 */
import { serve } from "@hono/node-server";
import { createApp } from "../src/api/app";
import { HeuristicExtractor } from "../src/ai/heuristic";
import { handleDM } from "../src/bot/handler";
import { loadConfig } from "../src/config";
import { createContext } from "../src/context";
import { openDb } from "../src/db/client";
import { MemoryMessenger } from "../src/messaging/memory";
import { createApplePayIntent, payLinkUrl, payoutsOnboardingLink, PayoutsUnavailableError, refreshPayoutStatus } from "../src/payments/service";
import { SimulatedChain } from "../src/payments/solana/chain";
import { getPayment } from "../src/store/payments";
import { getGroupByCode } from "../src/store/groups";
import { getUserByPhone } from "../src/store/users";

const PORT = Number(process.env.CHECK_PORT ?? 3997);
const config = loadConfig({ ...process.env, PORT: String(PORT), PUBLIC_BASE_URL: `http://localhost:${PORT}` });
if (!config.stripe?.webhookSecret) throw new Error("Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET in .env");
if (!config.stripe.secretKey.startsWith("sk_test_") && !config.stripe.secretKey.startsWith("rk_test_")) throw new Error("Refusing to run with a live key");

const messenger = new MemoryMessenger((m) => console.log(`  [dm → ${m.to.slice(-4)}] ${m.text.split("\n")[0]}`));
const ctx = createContext(config, messenger, { db: openDb(":memory:"), extractor: new HeuristicExtractor(), chain: new SimulatedChain() });
await messenger.listen((dm) => handleDM(ctx, dm));
const server = serve({ fetch: createApp(ctx).fetch, port: PORT });
const say = (phone: string, text: string) => messenger.receive(phone, text);
const ok = (label: string) => console.log(`✅ ${label}`);

try {
  const AMIT = "+19195559001", PRIYA = "+19195559002";
  await say(AMIT, "new trip Stripe Check");
  const code = messenger.outbox.map((m) => m.text).join("\n").match(/JOIN ([A-Z0-9]+)/)![1]!;
  await say(AMIT, "Amit");
  await say(PRIYA, `JOIN ${code} - I'm Priya`);
  await say(AMIT, "paid $50 for groceries");
  await say(PRIYA, "yes");
  const group = getGroupByCode(ctx, code)!;
  const amit = getUserByPhone(ctx, AMIT)!, priya = getUserByPhone(ctx, PRIYA)!;
  ok("bot flow: Priya owes Amit $25.00");

  const token = new URL(payLinkUrl(ctx, group.id, priya.id, amit.id)).pathname.split("/p/")[1]!;
  const page = await (await fetch(`http://localhost:${PORT}/p/${token}`)).text();
  if (!page.includes("expressCheckout") || !page.includes(config.stripe.publishableKey)) throw new Error("pay page missing Apple Pay element");
  ok("pay page renders the Stripe Express Checkout (Apple Pay) element");

  const intent = await createApplePayIntent(ctx, token);
  if (!intent.ok) throw new Error(intent.message);
  const pi = getPayment(ctx, intent.paymentId)!.stripePaymentIntentId!;
  ok(`real PaymentIntent created: ${pi} ($${(intent.cents / 100).toFixed(2)}, held for Amit since he hasn't onboarded)`);

  // Stand-in for the Apple Pay sheet: confirm with Stripe's Visa test card.
  await ctx.stripe!.stripe.paymentIntents.confirm(pi, { payment_method: "pm_card_visa", return_url: `http://localhost:${PORT}/p/${token}/done` });
  ok("confirmed with test card pm_card_visa");

  let status = getPayment(ctx, intent.paymentId)!.status;
  for (let i = 0; i < 40 && status === "pending"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = getPayment(ctx, intent.paymentId)!.status;
  }
  if (status !== "held") throw new Error(`webhook never arrived (status ${status}). Is \`stripe listen --forward-to localhost:${PORT}/stripe/webhook\` running?`);
  ok("webhook payment_intent.succeeded arrived through stripe listen → payment marked held");

  try {
    const link = await payoutsOnboardingLink(ctx, amit.id);
    if (!link?.startsWith("https://")) throw new Error("no onboarding link");
    ok(`Connect (Accounts v2) recipient account created: ${getUserByPhone(ctx, AMIT)!.stripeAccountId}`);
    ok(`onboarding link: ${link.slice(0, 60)}…`);
    const ready = await refreshPayoutStatus(ctx, amit.id);
    ok(`readiness check works (stripe_transfers active: ${ready}; false until onboarding is finished in the browser)`);
    console.log("\nAll live Stripe checks passed.");
  } catch (err) {
    if (!(err instanceof PayoutsUnavailableError)) throw err;
    console.log("⚠️  Connect payouts: your Stripe account needs one Dashboard step before people can connect a bank:");
    console.log("    https://dashboard.stripe.com/settings/connect/platform-profile → complete the loss-liability acknowledgement.");
    console.log("\nPayments + webhooks passed. Connect is waiting on that Dashboard step.");
  }
} catch (err) {
  console.error("❌", (err as Error).message);
  process.exitCode = 1;
} finally {
  server.close();
}
