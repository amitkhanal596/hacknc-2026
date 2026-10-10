import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { Extractor, ImageExtraction, ImageInput, Member, TextExtraction, TextInput } from "./types";

const textSchema = {
  type: "object",
  properties: {
    is_expense: { type: "boolean", description: "True if the message logs money someone spent for the group." },
    has_reason: { type: "boolean", description: "True only if the message says what the money was for (e.g. gas, dinner, Airbnb). 'pay me $20' has no reason." },
    reason: { type: "string", description: "Short label for what was bought, e.g. 'Gas' or 'Dinner at Curate'. Empty if none." },
    amount_cents: { type: "integer", description: "Amount in cents. 0 if no amount." },
    split_with_everyone: { type: "boolean", description: "True if the cost is shared by the whole group (or no one is specified)." },
    participant_ids: { type: "array", items: { type: "string" }, description: "Member ids sharing the cost when not everyone. Include the sender if they shared it." },
  },
  required: ["is_expense", "has_reason", "reason", "amount_cents", "split_with_everyone", "participant_ids"],
} as const;

const textResult = z.object({
  is_expense: z.boolean(),
  has_reason: z.boolean(),
  reason: z.string(),
  amount_cents: z.number().int(),
  split_with_everyone: z.boolean(),
  participant_ids: z.array(z.string()),
});

const imageSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["receipt", "chat_screenshot", "other"] },
    merchant: { type: "string" },
    date: { type: "string", description: "YYYY-MM-DD, empty if unknown" },
    total_cents: { type: "integer", description: "Final total paid in cents, including tax and tip. 0 if unknown." },
    subtotal_cents: { type: "integer" },
    tax_cents: { type: "integer" },
    tip_cents: { type: "integer" },
    items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, cents: { type: "integer" } }, required: ["name", "cents"] } },
    claimed_text: { type: "string", description: "For chat screenshots: the message describing the expense, verbatim." },
    confidence: { type: "number", description: "0 to 1: how sure you are about the total." },
  },
  required: ["kind", "merchant", "date", "total_cents", "confidence"],
} as const;

const imageResult = z.object({
  kind: z.enum(["receipt", "chat_screenshot", "other"]),
  merchant: z.string().optional(),
  date: z.string().optional(),
  total_cents: z.number().int().optional(),
  subtotal_cents: z.number().int().optional(),
  tax_cents: z.number().int().optional(),
  tip_cents: z.number().int().optional(),
  items: z.array(z.object({ name: z.string(), cents: z.number().int() })).optional(),
  claimed_text: z.string().optional(),
  confidence: z.number(),
});

const SYSTEM = `You help a group split shared costs over text message. You only extract facts; you never decide who owes what.
Rules:
- Use member ids exactly as given. Never invent ids.
- If the message doesn't say what the money was for, has_reason must be false.
- Amounts are in US cents (e.g. $42.10 -> 4210).`;

function memberList(members: Member[]) {
  return members.map((m) => `- id=${m.id} name=${m.name ?? "(unknown)"}`).join("\n");
}

const nonZero = (n: number | undefined) => (n && n > 0 ? n : undefined);
const nonEmpty = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);

export class GeminiExtractor implements Extractor {
  readonly name = "gemini";
  private ai: GoogleGenAI;

  constructor(apiKey: string, private model: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async extractFromText(input: TextInput): Promise<TextExtraction> {
    const prompt = `Group members:\n${memberList(input.members)}\n\nSender id: ${input.senderId}\n\nSender's recent messages (oldest first):\n${
      input.recent.map((r) => `> ${r}`).join("\n") || "(none)"
    }\n\nNew message:\n"""${input.text}"""`;
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { systemInstruction: SYSTEM, responseMimeType: "application/json", responseJsonSchema: textSchema, temperature: 0 },
    });
    const r = textResult.parse(JSON.parse(res.text ?? "{}"));
    const validIds = new Set(input.members.map((m) => m.id));
    const ids = r.participant_ids.filter((id) => validIds.has(id));
    return {
      isExpense: r.is_expense,
      hasReason: r.has_reason && !!nonEmpty(r.reason),
      reason: r.has_reason ? nonEmpty(r.reason) : undefined,
      amountCents: nonZero(r.amount_cents),
      participants: r.split_with_everyone || ids.length === 0 ? "all" : [...new Set([...ids])],
    };
  }

  async extractFromImage(input: ImageInput): Promise<ImageExtraction> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: input.mimeType, data: input.data.toString("base64") } },
            {
              text: `Is this a receipt, a screenshot of a chat message about an expense, or something else? Extract the details.${
                input.caption ? `\nThe sender wrote: "${input.caption}"` : ""
              }`,
            },
          ],
        },
      ],
      config: { systemInstruction: SYSTEM, responseMimeType: "application/json", responseJsonSchema: imageSchema, temperature: 0 },
    });
    const r = imageResult.parse(JSON.parse(res.text ?? "{}"));
    return {
      kind: r.kind,
      merchant: nonEmpty(r.merchant),
      date: /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "") ? r.date : undefined,
      totalCents: nonZero(r.total_cents),
      subtotalCents: nonZero(r.subtotal_cents),
      taxCents: nonZero(r.tax_cents),
      tipCents: nonZero(r.tip_cents),
      items: r.items,
      claimedText: nonEmpty(r.claimed_text),
      confidence: r.confidence,
    };
  }
}
