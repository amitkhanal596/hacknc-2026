import type { Group } from "../db/schema";

/**
 * Figuring out which trip a message is about, for people in more than one.
 * A trip is named by its join code or a distinctive word from its name:
 * "#asheville", "for the asheville trip", "apartment: $120 wifi", "settle asheville".
 */

const GENERIC = new Set(["trip", "the", "and", "group", "tab", "our", "with", "for", "weekend", "house"]);

export function tripKeywords(g: Group): string[] {
  const words = g.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
  return [...new Set([g.joinCode.toLowerCase(), ...words])];
}

/** The first distinctive word of a trip name, for "#asheville" hints. */
export function tripTag(g: Group): string {
  return tripKeywords(g)[1] ?? g.joinCode.toLowerCase();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which of these trips the text names, plus the text with the trip reference removed. */
export function findTripMention(text: string, groups: Group[]): { matches: Group[]; cleaned: string } {
  const lower = text.toLowerCase();
  const matches = groups.filter((g) => tripKeywords(g).some((k) => new RegExp(`(?:^|[^a-z0-9])#?${esc(k)}(?:'?s)?(?![a-z0-9])`).test(lower)));
  let cleaned = text;
  for (const g of matches) {
    for (const k of tripKeywords(g)) {
      const kw = esc(k);
      cleaned = cleaned
        .replace(new RegExp(`\\s*\\(\\s*#?${kw}(?:\\s+trip)?\\s*\\)`, "gi"), "")
        .replace(new RegExp(`\\s*\\b(?:for|on|in|to)\\s+(?:the\\s+|our\\s+)?#?${kw}(?:\\s+trip)?\\b`, "gi"), "")
        .replace(new RegExp(`^\\s*#?${kw}(?:\\s+trip)?\\s*[:,-]\\s*`, "i"), "")
        .replace(new RegExp(`\\s*#${kw}\\b`, "gi"), "");
    }
  }
  return { matches, cleaned: cleaned.replace(/\s{2,}/g, " ").trim() };
}

/** A reply to "which trip?": "1", "2", "asheville", "#apartment". */
export function parseTripChoice(text: string, options: Group[]): Group | undefined {
  const t = text.trim().toLowerCase().replace(/[.!)]+$/, "");
  const n = t.match(/^#?(\d{1,2})$/);
  if (n) return options[Number(n[1]) - 1];
  const { matches } = findTripMention(t, options);
  return matches.length === 1 ? matches[0] : undefined;
}

export function tripMenu(options: Group[]): string {
  return options.map((g, i) => `${i + 1}) ${g.name}`).join("\n");
}
