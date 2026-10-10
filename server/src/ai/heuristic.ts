import { parseDollarsToCents } from "../ledger/money";
import { FAKE_RECEIPT_MIME, type Extractor, type ImageExtraction, type ImageInput, type Member, type TextExtraction, type TextInput } from "./types";

/**
 * Regex fallback used when there's no Gemini key (the simulator, tests, or a
 * Gemini outage). It handles the common shapes: "paid $80 for gas",
 * "$45 groceries split with jake and sam", "dinner 96 everyone but amit".
 */
export class HeuristicExtractor implements Extractor {
  readonly name = "heuristic";

  async extractFromText(input: TextInput): Promise<TextExtraction> {
    const text = input.text.trim();
    const amountCents = findAmount(text);
    const participants = findParticipants(text, input.senderId, input.members);
    const reason = findReason(text, input.members);
    return {
      isExpense: amountCents !== undefined,
      hasReason: !!reason,
      reason,
      amountCents,
      participants,
    };
  }

  async extractFromImage(input: ImageInput): Promise<ImageExtraction> {
    if (input.mimeType === FAKE_RECEIPT_MIME) {
      return { confidence: 1, ...(JSON.parse(input.data.toString("utf8")) as Partial<ImageExtraction>), kind: "receipt" } as ImageExtraction;
    }
    // Can't read real images without Gemini.
    return { kind: "other", confidence: 0 };
  }
}

const MONEY_WITH_SIGN = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/;
const BARE_NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\w.%])/;

export function findAmount(text: string): number | undefined {
  // Ignore "split 4 ways" so the 4 isn't read as an amount.
  const cleaned = text.replace(/\b\d+\s*ways?\b/gi, " ").replace(/\b(\d+)\s*(people|of us|persons?)\b/gi, " ");
  const m = cleaned.match(MONEY_WITH_SIGN) ?? cleaned.match(BARE_NUMBER);
  if (!m) return undefined;
  return parseDollarsToCents(m[2] ? `${m[1]}.${m[2]}` : m[1]!);
}

const FILLER = new Set([
  "i", "me", "my", "we", "you", "paid", "pay", "spent", "spend", "bought", "covered", "got", "for", "on", "the", "a", "an",
  "split", "with", "and", "everyone", "everybody", "all", "of", "us", "but", "except", "ways", "way", "between", "to",
  "dollars", "dollar", "bucks", "usd", "please", "pls", "plz", "send", "owe", "owes", "back", "just", "it", "was", "is",
  "people", "evenly", "equally", "each", "total", "hey", "yo", "so",
]);

export function findReason(text: string, members: Member[]): string | undefined {
  const names = new Set(members.map((m) => m.name?.toLowerCase()).filter(Boolean) as string[]);
  // Prefer "for X" phrasing: "paid $80 for gas, split with everyone".
  const forMatch = text.match(/\bfor\s+(?:the\s+)?([^,.;!?]+?)(?=\s*(?:,|\.|;|!|\?|\bsplit\b|\bwith\b|\bbetween\b|$))/i);
  const candidate = forMatch?.[1] ?? text;
  const words = candidate
    .replace(MONEY_WITH_SIGN, " ")
    .replace(/\d+(\.\d+)?/g, " ")
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter((w) => w.length > 1 && !FILLER.has(w) && !names.has(w));
  const reason = words.join(" ").trim();
  return reason || undefined;
}

export function findParticipants(text: string, senderId: string, members: Member[]): "all" | string[] {
  const lower = text.toLowerCase();
  const mentioned = members.filter((m) => m.name && new RegExp(`\\b${escapeRegex(m.name.toLowerCase())}\\b`).test(lower));
  const exclusion = lower.match(/\b(?:but|except|minus|without)\b(.*)$/);
  if (exclusion) {
    const excluded = new Set(
      members.filter((m) => m.name && new RegExp(`\\b${escapeRegex(m.name.toLowerCase())}\\b`).test(exclusion[1]!)).map((m) => m.id),
    );
    if (excluded.size > 0) return members.map((m) => m.id).filter((id) => !excluded.has(id));
  }
  if (/\b(everyone|everybody|all of us|the group|all)\b/.test(lower) || mentioned.length === 0) return "all";
  // "split with jake and sam" or "me, jake, sam": the sender is always included.
  return [...new Set([senderId, ...mentioned.map((m) => m.id)])];
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
