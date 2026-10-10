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
  | { type: "settle" }
  | { type: "pay"; who?: string }
  | { type: "why"; who?: string }
  | { type: "yes"; all: boolean; numbers: number[] }
  | { type: "dispute"; number?: number; reason: string }
  | { type: "fix"; cents: number }
  | { type: "withdraw" }
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
  if (/^(balance|balances|bal|status|tab|what do i owe\??|how much do i owe\??)$/i.test(text)) return { type: "balance" };
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

  if ((m = text.match(/^(?:dispute|reject|wrong)\b(?:\s+#?(\d+)\b)?[\s:,-]*(.*)$/i))) {
    return { type: "dispute", number: m[1] ? Number(m[1]) : undefined, reason: m[2]!.trim() };
  }

  if ((m = text.match(/^fix(?:\s+it)?(?:\s+to)?\s+(\$?[\d,]+(?:\.\d{1,2})?)$/i))) {
    const cents = parseDollarsToCents(m[1]!);
    if (cents) return { type: "fix", cents };
  }

  if (/^(withdraw|remove it|delete it|cancel it|withdraw it)$/i.test(text)) return { type: "withdraw" };
  if (/^(payouts?|connect bank|get paid|set up payouts)$/i.test(text)) return { type: "payouts" };

  return undefined;
}

/** Does a free-text reply look like a first name (for the "what should I call you?" prompt)? */
export function looksLikeName(text: string): string | undefined {
  const t = text.trim().replace(/^(i'?m|im|i am|it'?s|call me|this is|my name is)\s+/i, "").replace(/[.!]+$/, "");
  if (/^[a-z][a-z'-]{0,20}(\s+[a-z][a-z'-]{0,20})?$/i.test(t) && parseCommand(t) === undefined) return titleCase(t);
  return undefined;
}
