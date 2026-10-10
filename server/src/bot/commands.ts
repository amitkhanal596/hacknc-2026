import type { Group } from "../db/schema";
import { parseDollarsToCents } from "../ledger/money";

export type Command =
  | { type: "help" }
  | { type: "new"; name: string; kind: Group["kind"] }
  | { type: "join"; code: string; name?: string }
  | { type: "use"; query: string }
  | { type: "groups" }
  | { type: "name"; name: string }
  | { type: "balance" }
  | { type: "summary" }
  | { type: "settle" }
  | { type: "pay"; who?: string }
  | { type: "why"; who?: string }
  | { type: "yes"; all: boolean; numbers: number[] }
  | { type: "dispute"; number?: number; reason: string }
  | { type: "fix"; cents: number }
  | { type: "withdraw" }
  | { type: "accept" }
  | { type: "payouts" };

const KIND_WORDS: Record<string, Group["kind"]> = {
  trip: "trip",
  group: "trip",
  tab: "trip",
  roommates: "roommates",
  apartment: "roommates",
  house: "roommates",
  dinner: "dinner",
  club: "club",
  team: "club",
};

function titleCase(s: string) {
  return s.replace(/\s+/g, " ").trim().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function groupNameFor(raw: string, kind: Group["kind"]): string {
  const name = titleCase(raw);
  if (kind === "trip" && !/\btrip$/i.test(name)) return `${name} Trip`;
  return name;
}

/** Parses a DM into a command. Anything that isn't a command is treated as a possible expense. */
export function parseCommand(input: string): Command | undefined {
  const text = input.trim().replace(/^@?tab[,:]?\s+/i, "").trim();
  if (!text) return undefined;
  let m: RegExpMatchArray | null;

  if (/^(help|\?|commands|menu|hi|hello|hey)$/i.test(text)) return { type: "help" };

  if ((m = text.match(/^(?:new|create|start)\s+(?:(\w+)\s+)?(.+)$/i))) {
    const kindWord = m[1]?.toLowerCase();
    const kind = (kindWord && KIND_WORDS[kindWord]) || "trip";
    const rawName = kindWord && KIND_WORDS[kindWord] ? m[2]! : `${m[1] ?? ""} ${m[2]}`;
    return { type: "new", kind, name: groupNameFor(rawName, kind) };
  }

  if ((m = text.match(/^join\s+([a-z0-9]{3,12})\b[\s,.:—–-]*(?:(?:i'?m|im|i am|this is|it'?s|name'?s)\s+)?([a-z][a-z .'-]{0,30})?$/i))) {
    return { type: "join", code: m[1]!.toUpperCase(), name: m[2] ? titleCase(m[2]) : undefined };
  }

  if ((m = text.match(/^(?:use|switch(?:\s+to)?)\s+(.+)$/i))) return { type: "use", query: m[1]!.trim() };
  if (/^(groups|my groups|trips|list)$/i.test(text)) return { type: "groups" };
  if ((m = text.match(/^(?:name|call me|my name is)\s+([a-z][a-z .'-]{0,30})$/i))) return { type: "name", name: titleCase(m[1]!) };
  if (/^(balance|balances|bal|status|what do i owe\??|how much do i owe\??)$/i.test(text)) return { type: "balance" };
  // "hey what are my expenses", "summary", "my tab", "show me my tab", "recap", "where do I stand?"
  if (
    /^(?:(?:hey|hi|yo|ok|so)[,!]?\s+)?(?:summary|recap|tab|my tab|expenses|my expenses|(?:what(?:'s| is| are)|show(?: me)?|send(?: me)?|can i see)\s+(?:my|the)\s+(?:expenses|tab|summary|total|running total)|where do i stand|how am i doing)\s*(?:today|so far)?[?.!]*$/i.test(text)
  ) {
    return { type: "summary" };
  }
  if (/^settle(\s+up)?!?$/i.test(text)) return { type: "settle" };

  // "PAY" or "PAY Amit". "pay me $20" is NOT a command: it falls through to the
  // expense path, which asks what the money was for.
  if ((m = text.match(/^pay(?:\s+([a-z][a-z .'-]{0,30}))?!?$/i)) && !/^pay\s+me\b/i.test(text)) {
    return { type: "pay", who: m[1]?.trim() || undefined };
  }

  if ((m = text.match(/^why\b(.*)$/i))) {
    const who = m[1]!.replace(/[^a-z\s]/gi, " ").replace(/\b(do|does|i|owe|so|much|is|this|the|it|am|what|for)\b/gi, " ").trim();
    return { type: "why", who: who || undefined };
  }

  if ((m = text.match(/^(?:yes|y|yep|yeah|yup|approve|approved|ok|okay|sure|👍)(?:\s+(all|\d+(?:[\s,&]+(?:and\s+)?\d+)*))?[.!]*$/i))) {
    const arg = m[1]?.toLowerCase();
    if (arg === "all") return { type: "yes", all: true, numbers: [] };
    return { type: "yes", all: false, numbers: arg ? arg.match(/\d+/g)!.map(Number) : [] };
  }

  // "nope, I didn't eat" (the friendly way). DISPUTE/FLAG/WRONG still work.
  if ((m = text.match(/^(?:nope|nah|not right|not mine|that'?s (?:wrong|not right)|flag|dispute|reject|wrong)\b(?:\s+#?(\d+)\b)?[\s:,.!-]*(.*)$/i))) {
    return { type: "dispute", number: m[1] ? Number(m[1]) : undefined, reason: m[2]!.trim() };
  }

  if ((m = text.match(/^fix(?:\s+it)?(?:\s+to)?\s+(\$?[\d,]+(?:\.\d{1,2})?)$/i))) {
    const cents = parseDollarsToCents(m[1]!);
    if (cents) return { type: "fix", cents };
  }

  // Payer accepting the amount the other person suggested in their dispute.
  if (/^(accept|accepted|accept it|deal)[.!]*$/i.test(text)) return { type: "accept" };

  if (/^(remove|delete|withdraw|remove it|delete it|cancel it|withdraw it|scrap it)[.!]*$/i.test(text)) return { type: "withdraw" };
  if (/^(payouts?|connect bank|get paid|set up payouts)$/i.test(text)) return { type: "payouts" };

  return undefined;
}

/** Does a free-text reply look like a first name (for the "what should I call you?" prompt)? */
export function looksLikeName(text: string): string | undefined {
  const t = text.trim().replace(/^(i'?m|im|i am|it'?s|call me|this is|my name is)\s+/i, "").replace(/[.!]+$/, "");
  if (/^[a-z][a-z'-]{0,20}(\s+[a-z][a-z'-]{0,20})?$/i.test(t) && parseCommand(t) === undefined) return titleCase(t);
  return undefined;
}

/**
 * Natural replies to a dispute that set a new total: "$30 is fine", "make it 40",
 * "change it to $40", "40 works", "ok 30". Only used when the sender has an open
 * dispute on one of their expenses, so a bare "$30" can't be misread elsewhere.
 */
export function parseFixReply(input: string): number | undefined {
  const text = input.trim().toLowerCase().replace(/[.!]+$/, "");
  if (text.split(/\s+/).length > 8) return undefined;
  const amount = String.raw`\$?\s?(\d[\d,]*(?:\.\d{1,2})?)(?:\s*(?:dollars|bucks))?`;
  const patterns = [
    new RegExp(String.raw`^(?:fix|change|update|make|set|lower|reduce|drop)\s+(?:it|that|this|the total|the amount|the price)?\s*(?:to\s+)?${amount}(?:\s+instead)?$`),
    new RegExp(String.raw`^(?:ok|okay|fine|sure|yeah|yes|alright|deal)?[,\s]*${amount}(?:\s+(?:is fine|works|is ok|is okay|then|instead|it is|sounds good|is good|total))?$`),
    new RegExp(String.raw`^(?:ok|okay|fine|sure|yeah|alright|deal)?[,\s]*(?:let'?s do|just|how about|i'?ll take)\s+${amount}$`),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseDollarsToCents(m[1]!);
  }
  return undefined;
}

/** "should be $30", "I'll pay $30": the amount someone suggests when disputing. */
export function suggestedAmount(reason: string): number | undefined {
  const m = reason.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|bucks)\b/i);
  return m ? parseDollarsToCents(m[1] ?? m[2]!) : undefined;
}

/** Loose "same expense" check: "Fortnite lessons" vs "fortnite lesson" vs "Fortnite". */
export function sameDescription(a: string, b: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/s$/, ""));
  const wa = new Set(words(a));
  const wb = words(b);
  if (wa.size === 0 || wb.length === 0) return false;
  const shared = wb.filter((w) => wa.has(w)).length;
  return shared >= Math.min(wa.size, wb.length);
}

/**
 * The payer correcting who an expense was for: "that was just for Ayug",
 * "only Jake and Priya", "all on Sam", "it was Ayug's", "split it with everyone".
 * Returns member ids (or "all"), or undefined if this isn't that kind of message.
 */
export function parseWhoFix(input: string, members: { id: string; name: string | null }[], senderId: string): string[] | "all" | undefined {
  const text = input.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/\d/.test(text) || text.split(/\s+/).length > 10) return undefined;
  const lead = String.raw`^(?:no,?\s*|nah,?\s*|oops,?\s*)?(?:(?:that|it|this)\s+(?:was|is|should be)\s+)?`;
  if (new RegExp(`${lead}(?:for\\s+|split\\s+(?:it\\s+)?(?:with|between)\\s+)?(?:everyone|everybody|all of us|the whole group)$`).test(text)) return "all";
  const m =
    text.match(new RegExp(`${lead}(?:only|just)\\s+(?:for\\s+)?(.+)$`)) ??
    text.match(new RegExp(`${lead}all\\s+on\\s+(.+)$`)) ??
    text.match(/^(?:no,?\s*)?(?:that|it|this)\s+(?:was|is)\s+(?:for\s+)?(.+?)$/);
  if (!m) return undefined;
  const who = m[1]!;
  const ids = members
    .filter((p) => p.name && new RegExp(`\\b${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:'?s)?\\b`).test(who))
    .map((p) => p.id);
  if (/\b(me|myself|mine)\b/.test(who)) ids.push(senderId);
  return ids.length ? [...new Set(ids)] : undefined;
}
