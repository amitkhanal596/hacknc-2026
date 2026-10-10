import { z } from "zod";
import { ensure } from "../domain/money";
export const extractionSchema = z
  .object({
    kind: z.enum([
      "expense_receipt",
      "payment_screenshot",
      "invoice_or_bill",
      "unrelated",
      "uncertain",
      "expense_text",
    ]),
    description: z.string().max(500),
    currency: z.literal("USD"),
    totalCents: z.number().int().positive().max(1_000_000).nullable(),
    payerId: z.string().nullable(),
    participantIds: z.array(z.string()).max(100),
    subtotalCents: z.number().int().nonnegative().nullable(),
    taxCents: z.number().int().nonnegative().nullable(),
    tipCents: z.number().int().nonnegative().nullable(),
    items: z
      .array(
        z.object({
          name: z.string().max(120),
          amountCents: z.number().int().nonnegative(),
        }),
      )
      .max(100),
    ambiguities: z.array(z.string().max(300)).max(10),
    paymentRecord: z
      .object({
        platform: z.enum(["venmo", "apple_cash", "zelle", "solana", "unknown"]),
        amountCents: z.number().int().positive().max(1_000_000).nullable(),
        sender: z.string().max(120).nullable(),
        recipient: z.string().max(120).nullable(),
        timestamp: z.string().max(100).nullable(),
        displayedStatus: z.string().max(100).nullable(),
        memo: z.string().max(300).nullable(),
        reference: z.string().max(200).nullable(),
        confidence: z.number().min(0).max(1),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type Extraction = z.infer<typeof extractionSchema>;
// Gemini's generation grammar rejects this schema with all numeric/length bounds.
// Keep the shape in the model request; enforce every bound with Zod after parsing.
export const geminiResponseSchema: Record<string, unknown> = JSON.parse(
  JSON.stringify(z.toJSONSchema(extractionSchema), (key, value) =>
    [
      "$schema",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
    ].includes(key)
      ? undefined
      : value,
  ),
);
export function validateExtraction(input: unknown, memberIds: string[]) {
  const e = extractionSchema.parse(input);
  ensure(
    !e.payerId || memberIds.includes(e.payerId),
    "UNKNOWN_MEMBER",
    "Payer is not a member.",
  );
  ensure(
    e.participantIds.every((id) => memberIds.includes(id)) &&
      new Set(e.participantIds).size === e.participantIds.length,
    "UNKNOWN_MEMBER",
    "Unknown or duplicate participant.",
  );
  if (
    e.subtotalCents !== null &&
    e.taxCents !== null &&
    e.tipCents !== null &&
    e.totalCents !== null
  )
    ensure(
      e.subtotalCents + e.taxCents + e.tipCents === e.totalCents,
      "RECEIPT_MISMATCH",
      "Receipt subtotal, tax and tip do not match total. Review the receipt.",
    );
  if (e.items.length && e.subtotalCents !== null)
    ensure(
      e.items.reduce((n, i) => n + i.amountCents, 0) === e.subtotalCents,
      "RECEIPT_MISMATCH",
      "Line items do not match subtotal.",
    );
  return e;
}
