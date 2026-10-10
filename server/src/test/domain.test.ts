import { describe, test, expect } from "bun:test";
import { split, customShares } from "../domain/split";
import { parseDollars, tokenUnits } from "../domain/money";
import { settle } from "../domain/settle";
import { harness, groceries } from "./helpers";
import { readConfig } from "../config";
import { encrypt, decrypt } from "../solana/wallets";
describe("integer-cent accounting", () => {
  test("100 / 3 conserves deterministic cents", () =>
    expect(split(10000, ["a", "b", "c"]).map((s) => s.cents)).toEqual([
      3334, 3333, 3333,
    ]));
  test("weighted largest remainders are deterministic", () =>
    expect(split(101, ["a", "b"], [1, 2]).map((s) => s.cents)).toEqual([
      34, 67,
    ]));
  test("small total allows zero shares", () =>
    expect(split(1, ["a", "b"]).map((s) => s.cents)).toEqual([1, 0]));
  test("custom shares sum exactly", () =>
    expect(
      customShares(100, [
        { userId: "a", cents: 80 },
        { userId: "b", cents: 20 },
      ]),
    ).toHaveLength(2));
  test.each([0, -10, 1.1, Number.MAX_SAFE_INTEGER, NaN])(
    "reject invalid amount %s",
    (n) => expect(() => split(n, ["a"])).toThrow(),
  );
  test("reject duplicates, empty subset, invalid weights and custom total", () => {
    expect(() => split(100, [])).toThrow();
    expect(() => split(100, ["a", "a"])).toThrow();
    expect(() => split(100, ["a"], [0])).toThrow();
    expect(() => customShares(100, [{ userId: "a", cents: 99 }])).toThrow();
  });
  test("currency string and token boundary exact", () => {
    expect(parseDollars("0.01")).toBe(1);
    expect(parseDollars("120.30")).toBe(12030);
    expect(tokenUnits(3000)).toBe(30000000n);
    expect(() => parseDollars("1.001")).toThrow();
  });
  test("four-person grocery example", () => {
    const h = harness();
    groceries(h.ledger);
    expect(h.ledger.balances("tahoe").map((b) => b.cents)).toEqual([
      9000, -3000, -3000, -3000,
    ]);
    h.store.sqlite.close();
  });
  test("payer excluded from subset still conserves value", () => {
    const h = harness();
    const e = h.ledger.propose("alex", {
      groupId: "tahoe",
      payerId: "alex",
      description: "Gift",
      currency: "USD",
      totalCents: 10000,
      participants: ["ben", "casey"],
    });
    h.ledger.review(e.id, "alex", "confirm");
    expect(h.ledger.balances("tahoe").map((b) => b.cents)).toEqual([
      10000, -5000, -5000, 0,
    ]);
    h.store.sqlite.close();
  });
  test("greedy plan deterministic, nonnegative and feasible across fixtures", () => {
    for (let n = 1; n < 150; n++) {
      const amounts = [n * 100, -n * 30, -n * 40, -n * 30];
      const b = amounts.map((cents, i) => ({ userId: String(i), cents }));
      const plan = settle(b);
      expect(plan).toEqual(settle([...b].reverse()));
      for (const t of plan) {
        expect(t.amountCents).toBeGreaterThan(0);
        amounts[Number(t.fromId)]! += t.amountCents;
        amounts[Number(t.toId)]! -= t.amountCents;
      }
      expect(amounts).toEqual([0, 0, 0, 0]);
    }
  });
  test("unbalanced netting rejected", () =>
    expect(() => settle([{ userId: "a", cents: 1 }])).toThrow());
});
describe("configuration and key protection", () => {
  test("mainnet fails closed", () =>
    expect(() => readConfig({ SOLANA_CLUSTER: "mainnet-beta" })).toThrow());
  test("network demo bind forbidden", () =>
    expect(() => readConfig({ DEMO_MODE: "true", HOST: "0.0.0.0" })).toThrow());
  test("custodial mode requires encryption key", () =>
    expect(() => readConfig({ DEMO_CUSTODIAL_WALLETS: "true" })).toThrow());
  test("AES-GCM random IV and authentication", () => {
    const secret = new Uint8Array([1, 2, 3]),
      key = "ab".repeat(32);
    const a = encrypt(secret, key),
      b = encrypt(secret, key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toEqual(secret);
    expect(() => decrypt(a, "cd".repeat(32))).toThrow();
  });
});
