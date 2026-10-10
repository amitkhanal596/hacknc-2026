import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../config";

test("server loads a credential from an external file without changing process environment", () => {
  const folder = mkdtempSync(join(tmpdir(), "tab-config-test-"));
  const file = join(folder, "credential");
  const previous = process.env.GEMINI_API_KEY;
  try {
    writeFileSync(file, "fixture-only-value\n", { mode: 0o600 });
    const c = readConfig({
      GEMINI_API_KEY_FILE: file,
      GEMINI_MODEL: "fixture-model",
    });
    expect(c.GEMINI_API_KEY).toBe("fixture-only-value");
    expect(process.env.GEMINI_API_KEY).toBe(previous);
    expect(() =>
      readConfig({
        GEMINI_API_KEY_FILE: file,
        GEMINI_API_KEY: "conflicting-fixture",
        GEMINI_MODEL: "fixture-model",
      }),
    ).toThrow("only one");
    writeFileSync(file, "invalid contents with whitespace");
    expect(() => readConfig({ GEMINI_API_KEY_FILE: file })).toThrow(
      "Cannot load Gemini credential file",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("missing external credential fails closed without exposing file details", () => {
  expect(() =>
    readConfig({ GEMINI_API_KEY_FILE: "/nonexistent/tab-credential-fixture" }),
  ).toThrow("Cannot load Gemini credential file");
});
