import type { Config } from "../config";
import { GeminiExtractor } from "./gemini";
import { HeuristicExtractor } from "./heuristic";
import type { Extractor, ImageInput, TextInput } from "./types";

export * from "./types";

/**
 * Uses Gemini when configured. If a Gemini call fails, it falls back to the
 * regex extractor so a flaky API doesn't break the bot mid-demo.
 */
export function createExtractor(config: Config): Extractor {
  const fallback = new HeuristicExtractor();
  if (!config.gemini) return fallback;
  const gemini = new GeminiExtractor(config.gemini.apiKey, config.gemini.model);
  return {
    name: "gemini",
    async extractFromText(input: TextInput) {
      try {
        return await gemini.extractFromText(input);
      } catch (err) {
        console.warn("[gemini] text extraction failed on every model, using the regex parser:", (err as Error).message);
        return fallback.extractFromText(input);
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
