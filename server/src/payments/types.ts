import type { Attempt, Destination, Intent } from "../db/schema";
export const methods = [
  "solana",
  "venmo",
  "apple_cash",
  "zelle",
  "cash",
] as const;
export type PaymentMethod = (typeof methods)[number];
export type PaymentCapability = {
  method: PaymentMethod;
  verification: "on_chain" | "recipient_confirmation";
  canExecuteFromBackend: boolean;
  requiresRecipientDestination: boolean;
  userFacingDescription: string;
  available: boolean;
};
export type PaymentInstructions = {
  method: PaymentMethod;
  recipientLabel: string;
  amountCents: number;
  instructionLines: string[];
  copyableRecipient?: string;
  copyableAmount: string;
  safetyNotice: string;
};
export type AuthorizedActor = {
  userId: string;
  attemptId: string;
  amountCents: number;
  recipientId: string;
};
export interface PaymentRail {
  readonly capability: PaymentCapability;
  prepare(
    intent: Intent,
    destination: Destination | null,
  ): Promise<PaymentInstructions>;
  executeAuthorized?(attempt: Attempt, auth: AuthorizedActor): Promise<Attempt>;
  verify?(attempt: Attempt): Promise<boolean>;
}
