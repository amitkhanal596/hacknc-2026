import type Stripe from "stripe";
import type { Ctx } from "../context";
import { railLabel } from "../copy";
import type { Payment } from "../db/schema";
import { payableCents } from "../ledger/debts";
import { formatCents as $ } from "../ledger/money";
import { dm } from "../notify";
import { audit } from "../store/expenses";
import { getGroup } from "../store/groups";
import { getPayment, heldPaymentsTo, insertPayment, paymentByIntent, updatePayment } from "../store/payments";
import { ensureWallet, getUser, getUserByStripeAccount, nameOf, updateUser } from "../store/users";
import { loadKeypair } from "./solana/wallets";
import { signToken, verifyToken } from "./tokens";

export type PayError = "nothing_owed" | "over_cap" | "rail_unavailable" | "failed" | "invalid_link";
export type PayResult = { ok: true; payment: Payment; explorerUrl?: string } | { ok: false; error: PayError; message: string };

const PAY_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export function payLinkUrl(ctx: Ctx, groupId: string, fromId: string, toId: string): string {
  const token = signToken({ t: "pay", groupId, fromId, toId, exp: ctx.now() + PAY_LINK_TTL_MS }, ctx.config.appSecret);
  return `${ctx.config.publicBaseUrl}/p/${token}`;
}

const TAB_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Read-only link to someone's tab: the summary page iMessage previews as a card. */
export function tabLinkUrl(ctx: Ctx, userId: string, groupId: string): string {
  const token = signToken({ t: "tab", userId, groupId, exp: ctx.now() + TAB_LINK_TTL_MS }, ctx.config.appSecret);
  return `${ctx.config.publicBaseUrl}/t/${token}`;
}

export function readTabLink(ctx: Ctx, token: string) {
  return verifyToken(token, ctx.config.appSecret, "tab", ctx.now());
}

export function readPayLink(ctx: Ctx, token: string) {
  return verifyToken(token, ctx.config.appSecret, "pay", ctx.now());
}

/** Sends tUSDC from the debtor's Tab wallet to the creditor's. Amount defaults to everything owed. */
export async function paySolana(
  ctx: Ctx,
  opts: { groupId: string; fromId: string; toId: string; cents?: number },
): Promise<PayResult> {
  const cap = payableCents(ctx, opts.groupId, opts.fromId, opts.toId);
  if (cap <= 0) return { ok: false, error: "nothing_owed", message: "Nothing is owed right now." };
  const cents = opts.cents ?? cap;
  if (cents <= 0 || cents > cap) return { ok: false, error: "over_cap", message: `You can pay at most ${$(cap)}.` };

  const from = await ensureWallet(ctx, getUser(ctx, opts.fromId)!);
  const to = await ensureWallet(ctx, getUser(ctx, opts.toId)!);
  const payment = insertPayment(ctx, { groupId: opts.groupId, fromId: from.id, toId: to.id, cents, rail: "solana" });

  try {
    const result = await ctx.chain.transfer(loadKeypair(from.walletSecretEnc!, ctx.config.walletEncKey), to.walletPubkey!, cents);
    const confirmed = updatePayment(ctx, payment.id, {
      status: "confirmed",
      solanaTxSig: result.signature,
      simulated: result.simulated,
      confirmedAt: ctx.now(),
    });
    audit(ctx, { paymentId: payment.id, actorId: from.id, action: "paid", detail: `${cents} solana ${result.signature}` });
    return { ok: true, payment: confirmed, explorerUrl: ctx.chain.explorerUrl(result.signature) };
  } catch (err) {
    updatePayment(ctx, payment.id, { status: "failed" });
    return { ok: false, error: "failed", message: `The transfer didn't go through (${(err as Error).message}).` };
  }
}

/** Tells the creditor they got paid. The payer's own confirmation is sent by whoever started the payment. */
export async function notifyCreditor(ctx: Ctx, payment: Payment, explorerUrl?: string) {
  const group = getGroup(ctx, payment.groupId);
  const from = getUser(ctx, payment.fromId);
  const to = getUser(ctx, payment.toId);
  let text = `💸 ${nameOf(from)} paid you ${$(payment.cents)} (${railLabel(payment)}) for ${group?.name ?? "your group"}.`;
  if (explorerUrl) text += ` ${explorerUrl}`;
  if (payment.status === "held") {
    // If they already started onboarding, send them straight back to it.
    const resume = to?.stripeAccountId && ctx.stripe ? await ctx.stripe.onboardingLink(to.stripeAccountId) : undefined;
    text += `\nStripe is holding it until you connect your bank: ${resume ?? "text PAYOUTS for a setup link."}`;
  }
  await dm(ctx, payment.toId, text);
}

// ---------------------------------------------------------------- Apple Pay (Stripe)

export async function createApplePayIntent(
  ctx: Ctx,
  token: string,
): Promise<{ ok: true; clientSecret: string; cents: number; paymentId: string } | { ok: false; error: PayError; message: string }> {
  if (!ctx.stripe) return { ok: false, error: "rail_unavailable", message: "Apple Pay isn't set up yet." };
  const link = readPayLink(ctx, token);
  if (!link) return { ok: false, error: "invalid_link", message: "This pay link expired. Text SETTLE for a new one." };
  const cents = payableCents(ctx, link.groupId, link.fromId, link.toId);
  if (cents <= 0) return { ok: false, error: "nothing_owed", message: "Nothing is owed right now." };

  const creditor = getUser(ctx, link.toId)!;
  const group = getGroup(ctx, link.groupId)!;
  const payment = insertPayment(ctx, { groupId: link.groupId, fromId: link.fromId, toId: link.toId, cents, rail: "apple_pay" });
  const intent = await ctx.stripe.createPaymentIntent({
    paymentId: payment.id,
    cents,
    destinationAccountId: creditor.stripePayoutsEnabled && creditor.stripeAccountId ? creditor.stripeAccountId : undefined,
    description: `Tab: ${group.name} (${nameOf(getUser(ctx, link.fromId))} → ${nameOf(creditor)})`,
  });
  updatePayment(ctx, payment.id, { stripePaymentIntentId: intent.id });
  return { ok: true, clientSecret: intent.client_secret!, cents, paymentId: payment.id };
}

/** Thrown when the Stripe account itself isn't set up for Connect payouts yet (a Dashboard step, not a code problem). */
export class PayoutsUnavailableError extends Error {}

/** Starts (or resumes) Stripe Connect onboarding for someone who wants card/Apple Pay payouts. */
export async function payoutsOnboardingLink(ctx: Ctx, userId: string): Promise<string | undefined> {
  if (!ctx.stripe) return undefined;
  let user = getUser(ctx, userId)!;
  if (!user.stripeAccountId) {
    try {
      user = updateUser(ctx, user.id, { stripeAccountId: await ctx.stripe.createRecipientAccount(user.id) });
    } catch (err) {
      if ((err as { code?: string }).code === "account_creation_losses_collector_unavailable") {
        console.error(
          "[stripe] Connect payouts need a one-time Dashboard step: Settings → Connect → Platform profile → complete the loss-liability acknowledgement (https://dashboard.stripe.com/settings/connect/platform-profile).",
        );
        throw new PayoutsUnavailableError("platform loss liability not acknowledged");
      }
      throw err;
    }
  }
  return ctx.stripe.onboardingLink(user.stripeAccountId!);
}

/**
 * Stripe webhooks are the only thing that marks an Apple Pay payment as paid.
 * Handlers are idempotent because Stripe retries.
 */
export async function handleStripeEvent(ctx: Ctx, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const intent = event.data.object;
      const payment = paymentByIntent(ctx, intent.id);
      // "failed" too: a slow payment we expired as stale still counts if Stripe says it succeeded.
      if (!payment || (payment.status !== "pending" && payment.status !== "failed")) return;
      const direct = !!intent.transfer_data?.destination;
      const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
      const updated = updatePayment(ctx, payment.id, {
        status: direct ? "confirmed" : "held",
        stripeChargeId: chargeId ?? null,
        confirmedAt: ctx.now(),
      });
      audit(ctx, { paymentId: payment.id, actorId: payment.fromId, action: "paid", detail: `${payment.cents} apple_pay ${updated.status}` });
      await dm(ctx, payment.fromId, `✅ Paid ${nameOf(getUser(ctx, payment.toId))} ${$(payment.cents)} with Apple Pay.`);
      await notifyCreditor(ctx, updated);
      return;
    }
    case "payment_intent.payment_failed": {
      const payment = paymentByIntent(ctx, event.data.object.id);
      if (!payment || payment.status !== "pending") return;
      updatePayment(ctx, payment.id, { status: "failed" });
      await dm(ctx, payment.fromId, "Your Apple Pay payment didn't go through. Try the link again, or reply PAY to send USDC instead.");
      return;
    }
    case "account.updated": {
      // Treat the event as a nudge and re-read v2 capability status (the source of truth).
      const user = getUserByStripeAccount(ctx, event.data.object.id);
      if (user) await refreshPayoutStatus(ctx, user.id);
      return;
    }
    case "transfer.created": {
      const paymentId = event.data.object.metadata?.payment_id;
      const payment = paymentId ? getPayment(ctx, paymentId) : undefined;
      if (payment && payment.status === "held") {
        updatePayment(ctx, payment.id, { status: "released", stripeTransferId: event.data.object.id });
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Re-checks whether a creditor can receive transfers (Accounts v2 capability
 * status). On the first switch to "ready", tells them and releases held money.
 * Called from the account webhook, the onboarding return page, and the sweep job.
 */
export async function refreshPayoutStatus(ctx: Ctx, userId: string): Promise<boolean> {
  const user = getUser(ctx, userId);
  if (!ctx.stripe || !user?.stripeAccountId) return false;
  const ready = await ctx.stripe.canReceiveTransfers(user.stripeAccountId);
  if (ready && !user.stripePayoutsEnabled) {
    updateUser(ctx, user.id, { stripePayoutsEnabled: true });
    await dm(ctx, user.id, "✅ Payouts are set up. Apple Pay payments to you will go straight to your bank.");
    await releaseHeldPayments(ctx, user.id);
  } else if (!ready && user.stripePayoutsEnabled) {
    updateUser(ctx, user.id, { stripePayoutsEnabled: false });
  }
  return ready;
}

/** Sends held Apple Pay money to a creditor who just finished onboarding. */
export async function releaseHeldPayments(ctx: Ctx, creditorId: string): Promise<number> {
  const creditor = getUser(ctx, creditorId);
  if (!ctx.stripe || !creditor?.stripeAccountId || !creditor.stripePayoutsEnabled) return 0;
  let released = 0;
  for (const p of heldPaymentsTo(ctx, creditorId)) {
    if (!p.stripeChargeId) continue;
    try {
      const transfer = await ctx.stripe.releaseHeld({
        paymentId: p.id,
        cents: p.cents,
        destinationAccountId: creditor.stripeAccountId,
        chargeId: p.stripeChargeId,
      });
      updatePayment(ctx, p.id, { status: "released", stripeTransferId: transfer.id });
      released += p.cents;
    } catch (err) {
      console.error(`[stripe] couldn't release held payment ${p.id}:`, (err as Error).message);
    }
  }
  if (released > 0) await dm(ctx, creditorId, `💸 ${$(released)} in held Apple Pay payments is on its way to your bank.`);
  return released;
}
