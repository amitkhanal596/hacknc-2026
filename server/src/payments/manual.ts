import type { Destination, Intent } from "../db/schema";
import { ensure, formatMoney } from "../domain/money";
import type { PaymentMethod, PaymentRail } from "./types";
const steps = {
  venmo:
    "Open Venmo yourself. Find the recipient-supplied handle and verify the person before paying.",
  apple_cash:
    "Open Apple Cash in Messages or Wallet. Select the recipient-supplied contact and authorize the payment there.",
  zelle:
    "Open Zelle in your participating bank app. Verify the recipient-supplied enrolled contact before paying.",
  cash: "Hand the exact cash amount to the intended recipient.",
};
export class ManualRail implements PaymentRail {
  readonly capability;
  constructor(public method: Exclude<PaymentMethod, "solana">) {
    this.capability = {
      method,
      verification: "recipient_confirmation" as const,
      canExecuteFromBackend: false,
      requiresRecipientDestination: method !== "cash",
      userFacingDescription: "Pay independently; recipient confirms receipt.",
      available: true,
    };
  }
  async prepare(intent: Intent, destination: Destination | null) {
    ensure(
      this.method === "cash" || destination?.verified,
      "DESTINATION_REQUIRED",
      "The recipient must save and confirm their payment details first.",
      409,
    );
    return {
      method: this.method,
      recipientLabel: intent.toId,
      amountCents: intent.amountCents,
      instructionLines: [
        steps[this.method],
        `Pay ${formatMoney(intent.amountCents)}. Note: Tab ${intent.id.slice(0, 8)}.`,
        "Return to Tab and choose “I’ve paid”. The recipient must independently confirm receipt.",
      ],
      copyableRecipient: destination?.address,
      copyableAmount: formatMoney(intent.amountCents).slice(1),
      safetyNotice:
        "Recipient-supplied details, not provider-verified. A screenshot or sender claim does not settle the debt.",
    };
  }
}
