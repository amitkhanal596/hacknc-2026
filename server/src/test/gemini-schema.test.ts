import { expect, test } from "bun:test";
import { receiptFixture } from "../ai/extractor";
import { validateExtraction } from "../ai/schemas";
test("model-side schema simplification cannot relax backend expense limits", () => {
  const base = { ...receiptFixture, payerId: "alex", participantIds: ["alex"] };
  expect(() =>
    validateExtraction({ ...base, totalCents: 1_000_001 }, ["alex"]),
  ).toThrow();
  expect(() =>
    validateExtraction({ ...base, description: "x".repeat(501) }, ["alex"]),
  ).toThrow();
  expect(() =>
    validateExtraction({ ...base, totalCents: 1.5 }, ["alex"]),
  ).toThrow();
  expect(() =>
    validateExtraction({ ...base, payerId: "unrecognized" }, ["alex"]),
  ).toThrow();
});
