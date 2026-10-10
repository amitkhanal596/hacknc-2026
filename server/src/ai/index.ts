import type { Config } from "../config";
import { GeminiExtractor } from "./gemini";
import { HeuristicExtractor } from "./heuristic";
import type { Extractor, ImageInput, TextExtraction, TextInput } from "./types";

export * from "./types";

/**
 * Simple texts ("paid $80 for gas", "$45 groceries split with jake and sam")
 * are handled by the regex parser without calling Gemini, which saves the
 * free tier's small daily quota for photos and tricky messages.
 */
export function simpleEnough(text: string, parsed: TextExtraction): boolean {
  if (!parsed.isExpense || !parsed.amountCents || !parsed.hasReason) return false;
  if (text.split(/\s+/).length > 14) return false;
  if ((text.match(/\d+(?:\.\d+)?/g) ?? []).length > 1) return false; // "30 for gas and 20 for snacks"
  return !/\b(half|each|percent|%|not|didn'?t|don'?t|wasn'?t|isn'?t|never|instead|refund|minus|plus|except|but|without|unless|then|also|both)\b|\d\s*\/\s*\d/i.test(text);
}

/** Words that can carry an amount without digits ("twenty bucks"). */
const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|half|dozen)\b/i;

/**
 * Uses Gemini when configured, but only when it adds something: simple texts
 * go through the regex parser, and messages with no amount at all ("lol see you
 * tomorrow") never reach Gemini. If Gemini fails on every model, falls back to
 * the regex parser so a flaky API doesn't break the bot mid-demo.
 */
export function createExtractor(config: Config, geminiOverride?: Extractor): Extractor {
  const fallback = new HeuristicExtractor();
  if (!config.gemini && !geminiOverride) return fallback;
  const gemini = geminiOverride ?? new GeminiExtractor(config.gemini!.apiKey, config.gemini!.model);
  return {
    name: "gemini",
    async extractFromText(input: TextInput) {
      const quick = await fallback.extractFromText(input);
      if (simpleEnough(input.text, quick)) return quick;
      if (!/\d/.test(input.text) && !NUMBER_WORDS.test(input.text)) return quick; // no amount anywhere: not an expense
      try {
        return await gemini.extractFromText(input);
      } catch (err) {
        console.warn("[gemini] text extraction failed on every model, using the regex parser:", (err as Error).message);
        return quick;
      }
    },
    async extractFromImage(input: ImageInput) {
      try {
        return await gemini.extractFromImage(input);
      } catch (err) {
        console.warn("[gemini] image extraction failed on every model:", (err as Error).message);
        const r = await fallback.extractFromImage(input);
        return r.kind === "other" ? { ...r, unavailable: true } : r;
      }
    },
  };
}
