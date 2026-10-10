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
  "people", "evenly", "equally", "each", "total", "hey", "yo", "so", "cost", "costs", "costed", "was", "were",
]);

/** Does the text name this member, including possessives like "ayug's" or "ayugs"? */
function mentions(lower: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegex(name.toLowerCase())}(?:'?s)?\\b`).test(lower);
}

/**
 * Paying for one specific person: "paid ayug's meal", "covered Jake's dinner",
 * "bought Priya a coffee", "got lunch for Sam". Returns those people (never the sender).
 */
function paidForSomeone(lower: string, senderId: string, members: Member[]): string[] | undefined {
  const named = members.filter((m) => m.id !== senderId && m.name);
  const possessive = named.filter((m) => new RegExp(`\\b${escapeRegex(m.name!.toLowerCase())}'?s\\b`).test(lower));
  if (possessive.length) return possessive.map((m) => m.id);
  const bought = named.filter((m) => new RegExp(`\\b(?:bought|got|treated|covered)\\s+${escapeRegex(m.name!.toLowerCase())}\\b`).test(lower));
  if (bought.length) return bought.map((m) => m.id);
  const forName = named.filter((m) => new RegExp(`\\bfor\\s+${escapeRegex(m.name!.toLowerCase())}\\b`).test(lower));
  if (forName.length && !/\b(split|with|and me|me and)\b/.test(lower)) return forName.map((m) => m.id);
  return undefined;
}

export function findReason(text: string, members: Member[]): string | undefined {
  const names = new Set(members.map((m) => m.name?.toLowerCase()).filter(Boolean) as string[]);
  // Prefer "for X" phrasing: "paid $80 for gas, split with everyone".
  const forMatch = text.match(/\bfor\s+(?:the\s+)?([^,.;!?]+?)(?=\s*(?:,|\.|;|!|\?|\bsplit\b|\bwith\b|\bbetween\b|$))/i);
  const clean = (candidate: string) =>
    candidate
      .replace(MONEY_WITH_SIGN, " ")
      .replace(/\d+(\.\d+)?/g, " ")
      .toLowerCase()
      .split(/[^a-z']+/)
      .filter((w) => w.length > 1 && !FILLER.has(w) && !names.has(w) && !names.has(w.replace(/'?s$/, "")))
      .join(" ")
      .trim();
  // "got lunch for jake": the words after "for" are just a name, so use the whole sentence.
  const reason = (forMatch ? clean(forMatch[1]!) : "") || clean(text);
  return reason || undefined;
}

export function findParticipants(text: string, senderId: string, members: Member[]): "all" | string[] {
  const lower = text.toLowerCase();
  const mentioned = members.filter((m) => m.name && mentions(lower, m.name));
  // "paid ayug's meal": the sender paid and only Ayug owes it.
  const forSomeone = paidForSomeone(lower, senderId, members);
  if (forSomeone) return forSomeone;
  // "Jake owes me $20 for gas": the sender paid and Jake owes all of it.
  if (/\bow(?:es|ed|e)\s+me\b/.test(lower)) {
    const debtors = mentioned.filter((m) => m.id !== senderId).map((m) => m.id);
    if (debtors.length) return debtors;
  }
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
