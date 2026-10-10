import { describe, expect, it } from "vitest";
import { GeminiExtractor } from "../src/ai/gemini";

const OK_IMAGE = JSON.stringify({ kind: "receipt", merchant: "Shell", date: "2026-10-11", total_cents: 8000, confidence: 0.9 });

/** A GeminiExtractor whose network calls go to `responder(model)` instead of Google. */
function fakeGemini(models: string, responder: (model: string) => unknown) {
  let now = 0;
  const calls: string[] = [];
  const g = new GeminiExtractor("test-key", models, () => now);
  (g as unknown as { ai: unknown }).ai = {
    models: {
      generateContent: async ({ model }: { model: string }) => {
        calls.push(model);
        const r = responder(model);
        if (r instanceof Error) throw r;
        return { text: r };
      },
    },
  };
  return { g, calls, advance: (ms: number) => (now += ms) };
}

const err = (status: number, message: string) => Object.assign(new Error(message), { status });
const image = { data: Buffer.from("x"), mimeType: "image/jpeg", members: [] };

describe("Gemini model fallback", () => {
  it("moves to the next model when one is busy or out of quota, and rests the failed ones", async () => {
    const { g, calls, advance } = fakeGemini("a,b,c", (m) =>
      m === "a" ? err(503, "high demand") : m === "b" ? err(429, "RESOURCE_EXHAUSTED quota") : OK_IMAGE,
    );
    expect(await g.extractFromImage(image)).toMatchObject({ kind: "receipt", totalCents: 8000, merchant: "Shell" });
    expect(calls).toEqual(["a", "b", "c"]);

    calls.length = 0;
    await g.extractFromImage(image);
    expect(calls).toEqual(["c"]); // a and b are cooling down

    advance(61_000); // the busy model is back after a minute; the quota one isn't
    calls.length = 0;
    await g.extractFromImage(image);
    expect(calls).toEqual(["a", "c"]);
  });

  it("doesn't try other models for errors they can't fix (bad request)", async () => {
    const { g, calls } = fakeGemini("a,b", () => err(400, "invalid argument"));
    await expect(g.extractFromImage(image)).rejects.toThrow("invalid argument");
    expect(calls).toEqual(["a"]);
  });

  it("throws when every model fails, so the caller can fall back", async () => {
    const { g } = fakeGemini("a,b", () => err(503, "UNAVAILABLE"));
    await expect(g.extractFromImage(image)).rejects.toThrow("UNAVAILABLE");
  });
});
