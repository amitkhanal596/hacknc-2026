import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app";
import { sweepHeldPayments } from "../src/jobs";
import { groupDebts } from "../src/ledger/debts";
import { owed } from "../src/ledger/settle";
import { createApplePayIntent, handleStripeEvent, payLinkUrl, refreshPayoutStatus } from "../src/payments/service";
import type { StripeRail } from "../src/payments/stripe/rail";
import { getPayment } from "../src/store/payments";
import { getGroupByCode } from "../src/store/groups";
import { getUserByPhone } from "../src/store/users";
import { makeBot, PHONES } from "./helpers";

/** Records calls instead of hitting Stripe. */
function fakeStripe() {
  const calls: { method: string; args: unknown }[] = [];
  let ready = false;
  const rail = {
    publishableKey: "pk_test_fake",
    async createPaymentIntent(args: { paymentId: string; cents: number; destinationAccountId?: string }) {
      calls.push({ method: "createPaymentIntent", args });
      return { id: `pi_${args.paymentId}`, client_secret: `pi_${args.paymentId}_secret` } as Stripe.PaymentIntent;
    },
    async createRecipientAccount(userId: string) {
      calls.push({ method: "createRecipientAccount", args: userId });
      return "acct_amit";
    },
    async onboardingLink(accountId: string) {
      return `https://connect.stripe.test/onboard/${accountId}`;
    },
    async canReceiveTransfers() {
      return ready;
    },
    async releaseHeld(args: { paymentId: string }) {
      calls.push({ method: "releaseHeld", args });
      return { id: `tr_${args.paymentId}` } as Stripe.Transfer;
    },
    parseWebhook(): Stripe.Event {
      throw new Error("not used");
    },
  };
  return { rail: rail as unknown as StripeRail, calls, setReady: (v: boolean) => (ready = v) };
}

const succeeded = (intentId: string, destination?: string) =>
  ({
    type: "payment_intent.succeeded",
    data: { object: { id: intentId, latest_charge: `ch_${intentId}`, transfer_data: destination ? { destination } : null } },
  }) as unknown as Stripe.Event;

describe("Apple Pay via Stripe (faked)", () => {
  it("holds money for a creditor who hasn't onboarded, then releases it when Connect is ready", async () => {
    const bot = makeBot();
    const stripe = fakeStripe();
    bot.ctx.stripe = stripe.rail;

    const code = (await bot.say("amit", "new trip Asheville")).match(/JOIN ([A-Z0-9]+)/)![1]!;
    await bot.say("amit", "Amit");
    await bot.say("priya", `JOIN ${code} - I'm Priya`);
    await bot.say("amit", "paid $50 for groceries");
    await bot.say("priya", "yes");
    const group = getGroupByCode(bot.ctx, code)!;
    const amit = getUserByPhone(bot.ctx, PHONES.amit)!;
    const priya = getUserByPhone(bot.ctx, PHONES.priya)!;

    // With Stripe on, the settle-up text includes an Apple Pay link.
    await bot.say("amit", "settle");
    const settleText = bot.read("priya");
    expect(settleText).toMatch(/Or pay with Apple Pay: http:\/\/localhost:3000\/p\//);

    // The pay page renders the Apple Pay button.
    const path = new URL(payLinkUrl(bot.ctx, group.id, priya.id, amit.id)).pathname;
    const page = await (await createApp(bot.ctx).request(path)).text();
    expect(page).toContain("expressCheckout");
    expect(page).toContain("pk_test_fake");

    // Amit hasn't onboarded, so the intent has no destination (money is held on the platform).
    const intent = await createApplePayIntent(bot.ctx, path.split("/p/")[1]!);
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;
    expect(intent.cents).toBe(2500);
    expect(stripe.calls.find((c) => c.method === "createPaymentIntent")!.args).toMatchObject({ cents: 2500, destinationAccountId: undefined });

    // A second attempt while the first is in flight can't overpay.
    const again = await createApplePayIntent(bot.ctx, path.split("/p/")[1]!);
    expect(again).toMatchObject({ ok: false, error: "nothing_owed" });

    // The webhook is what marks it paid.
    await handleStripeEvent(bot.ctx, succeeded(`pi_${intent.paymentId}`));
    expect(getPayment(bot.ctx, intent.paymentId)!.status).toBe("held");
    expect(owed(groupDebts(bot.ctx, group.id), priya.id, amit.id)).toBe(0); // held counts as paid for Priya
    expect(bot.read("priya")).toContain("✅ Paid Amit $25.00 with Apple Pay.");
    expect(bot.read("amit")).toContain("Stripe is holding it until you connect your bank");

    // Replaying the webhook does nothing (Stripe retries).
    await handleStripeEvent(bot.ctx, succeeded(`pi_${intent.paymentId}`));
    expect(bot.read("priya")).toBe("");

    // Amit sets up payouts; once Stripe says the account is ready, held money is released.
    expect(await bot.say("amit", "payouts")).toContain("https://connect.stripe.test/onboard/acct_amit");
    expect(await sweepHeldPayments(bot.ctx)).toBe(0); // not ready yet
    stripe.setReady(true);
    await sweepHeldPayments(bot.ctx);
    expect(getPayment(bot.ctx, intent.paymentId)).toMatchObject({ status: "released", stripeTransferId: `tr_${intent.paymentId}` });
    const amitInbox = bot.read("amit");
    expect(amitInbox).toContain("✅ Payouts are set up.");
    expect(amitInbox).toContain("$25.00 in held Apple Pay payments is on its way to your bank.");
  });

  it("uses a destination charge when the creditor is already onboarded", async () => {
    const bot = makeBot();
    const stripe = fakeStripe();
    bot.ctx.stripe = stripe.rail;
    const code = (await bot.say("amit", "new trip Asheville")).match(/JOIN ([A-Z0-9]+)/)![1]!;
    await bot.say("amit", "Amit");
    await bot.say("priya", `JOIN ${code} - I'm Priya`);
    await bot.say("amit", "paid $50 for groceries");
    await bot.say("priya", "yes");
    stripe.setReady(true);
    await bot.say("amit", "payouts");

    const group = getGroupByCode(bot.ctx, code)!;
    const amit = getUserByPhone(bot.ctx, PHONES.amit)!;
    const priya = getUserByPhone(bot.ctx, PHONES.priya)!;
    // Mark Amit ready the way the onboarding return page / account webhook would.
    await refreshPayoutStatus(bot.ctx, amit.id);

    const token = new URL(payLinkUrl(bot.ctx, group.id, priya.id, amit.id)).pathname.split("/p/")[1]!;
    const intent = await createApplePayIntent(bot.ctx, token);
    if (!intent.ok) throw new Error(intent.message);
    expect(stripe.calls.find((c) => c.method === "createPaymentIntent")!.args).toMatchObject({ destinationAccountId: "acct_amit" });
    await handleStripeEvent(bot.ctx, succeeded(`pi_${intent.paymentId}`, "acct_amit"));
    expect(getPayment(bot.ctx, intent.paymentId)!.status).toBe("confirmed");
    expect(bot.read("amit")).toContain("💸 Priya paid you $25.00 (Apple Pay)");
  });
});
