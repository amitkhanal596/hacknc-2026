import Stripe from "stripe";

/**
 * Apple Pay through Stripe (test mode), paid out to creditors in USD via
 * Stripe Connect Express. Thin wrapper; business rules live in payments/service.ts.
 */
export class StripeRail {
  readonly stripe: Stripe;

  constructor(
    private opts: { secretKey: string; publishableKey: string; webhookSecret?: string; publicBaseUrl: string },
  ) {
    this.stripe = new Stripe(opts.secretKey);
  }

  get publishableKey() {
    return this.opts.publishableKey;
  }

  /**
   * If the creditor can receive payouts, it's a destination charge (money goes
   * straight to them). Otherwise the charge stays on our platform account
   * ("held") and gets transferred once they finish onboarding.
   */
  async createPaymentIntent(opts: {
    paymentId: string;
    cents: number;
    destinationAccountId?: string;
    description: string;
  }): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.create(
      {
        amount: opts.cents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        description: opts.description,
        metadata: { payment_id: opts.paymentId },
        transfer_group: opts.paymentId,
        ...(opts.destinationAccountId ? { transfer_data: { destination: opts.destinationAccountId } } : {}),
      },
      { idempotencyKey: `pi_${opts.paymentId}` },
    );
  }

  /**
   * Connect Accounts v2, marketplace-style recipient: Express dashboard, the
   * platform is merchant of record and owns fees/losses, and the only capability
   * requested is receiving transfers (no card_payments, so onboarding is shorter).
   */
  async createRecipientAccount(userId: string, email?: string): Promise<string> {
    // Stripe requires a contact email on recipient accounts. We only know phone
    // numbers, so test mode uses a placeholder; live mode needs a real one.
    const testMode = /^(sk|rk)_test_/.test(this.opts.secretKey);
    if (!email && !testMode) throw new Error("A contact email is required to create live payout accounts.");
    const account = await this.stripe.v2.core.accounts.create({
      contact_email: email ?? `tab-user-${userId.replace(/[^a-z0-9]/gi, "")}@example.com`,
      dashboard: "express",
      identity: { country: "us", entity_type: "individual" },
      defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      metadata: { user_id: userId },
    });
    return account.id;
  }

  async onboardingLink(accountId: string): Promise<string> {
    const link = await this.stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          refresh_url: `${this.opts.publicBaseUrl}/connect/refresh?account=${accountId}`,
          return_url: `${this.opts.publicBaseUrl}/connect/return?account=${accountId}`,
        },
      },
    });
    return link.url;
  }

  /** v2 readiness check: can this account receive transfers yet? */
  async canReceiveTransfers(accountId: string): Promise<boolean> {
    const account = await this.stripe.v2.core.accounts.retrieve(accountId, { include: ["configuration.recipient"] });
    return account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
  }

  /** Moves a held charge to the creditor. `source_transaction` means we don't wait for the funds to clear. */
  async releaseHeld(opts: { paymentId: string; cents: number; destinationAccountId: string; chargeId: string }) {
    return this.stripe.transfers.create(
      {
        amount: opts.cents,
        currency: "usd",
        destination: opts.destinationAccountId,
        source_transaction: opts.chargeId,
        transfer_group: opts.paymentId,
        metadata: { payment_id: opts.paymentId },
      },
      { idempotencyKey: `release_${opts.paymentId}` },
    );
  }

  parseWebhook(rawBody: string, signature: string | undefined): Stripe.Event {
    if (!this.opts.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
    if (!signature) throw new Error("missing Stripe-Signature header");
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.opts.webhookSecret);
  }
}
