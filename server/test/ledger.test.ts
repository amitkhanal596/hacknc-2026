import { describe, expect, it } from "vitest";
import { initialShare, transition } from "../src/ledger/approvals";
import { formatCents, parseDollarsToCents } from "../src/ledger/money";
import { netBalances, owed, pairwiseDebts, simplify, type LedgerShare } from "../src/ledger/settle";
import { splitCustom, splitEqual } from "../src/ledger/splits";
import { validateExpense } from "../src/ledger/validate";

const sum = (xs: { cents: number }[]) => xs.reduce((a, b) => a + b.cents, 0);

describe("money", () => {
  it("formats and parses cents", () => {
    expect(formatCents(4210)).toBe("$42.10");
    expect(formatCents(-5)).toBe("-$0.05");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(parseDollarsToCents("$80")).toBe(8000);
    expect(parseDollarsToCents("12.3")).toBe(1230);
    expect(parseDollarsToCents("1,200.05")).toBe(120005);
    expect(parseDollarsToCents("abc")).toBeUndefined();
    expect(parseDollarsToCents("1.234")).toBeUndefined();
  });
});

describe("splits", () => {
  it("splits evenly and always adds up exactly", () => {
    for (const total of [1, 99, 100, 8000, 9601, 33333]) {
      for (let n = 1; n <= 7; n++) {
        const ids = Array.from({ length: n }, (_, i) => `u${i}`);
        const shares = splitEqual(total, ids);
        expect(sum(shares)).toBe(total);
        const amounts = shares.map((s) => s.cents);
        expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("gives leftover cents to the first participants and dedupes", () => {
    expect(splitEqual(100, ["a", "b", "c", "a"])).toEqual([
      { userId: "a", cents: 34 },
      { userId: "b", cents: 33 },
      { userId: "c", cents: 33 },
    ]);
  });

  it("can give leftover cents to the payer so everyone else pays the same", () => {
    expect(splitEqual(8000, ["amit", "jake", "priya"], "amit")).toEqual([
      { userId: "amit", cents: 2668 },
      { userId: "jake", cents: 2666 },
      { userId: "priya", cents: 2666 },
    ]);
  });

  it("rejects bad input", () => {
    expect(() => splitEqual(0, ["a"])).toThrow();
    expect(() => splitEqual(100, [])).toThrow();
    expect(() => splitCustom(100, [{ userId: "a", cents: 60 }, { userId: "b", cents: 30 }])).toThrow(/add up/);
  });
});

describe("settle", () => {
  // Asheville scenario: Amit paid gas $80 split 4 ways, Priya paid dinner $96 split with Jake + Sam.
  const shares: LedgerShare[] = [
    ...splitEqual(8000, ["amit", "jake", "priya", "sam"]).map((s) => ({ ...s, payerId: "amit", status: "approved" as const })),
    ...splitEqual(9600, ["priya", "jake", "sam"]).map((s) => ({ ...s, payerId: "priya", status: "approved" as const })),
  ];

  it("computes pairwise debts from approved shares only", () => {
    const debts = pairwiseDebts(shares, []);
    expect(owed(debts, "jake", "amit")).toBe(2000);
    expect(owed(debts, "jake", "priya")).toBe(3200);
    expect(owed(debts, "sam", "priya")).toBe(3200);
    expect(owed(debts, "priya", "amit")).toBe(2000);
    expect(owed(debts, "amit", "jake")).toBe(0);
  });

  it("ignores pending, disputed and rejected shares", () => {
    const mixed: LedgerShare[] = [
      { payerId: "amit", userId: "jake", cents: 500, status: "pending" },
      { payerId: "amit", userId: "jake", cents: 700, status: "disputed" },
      { payerId: "amit", userId: "jake", cents: 900, status: "rejected" },
      { payerId: "amit", userId: "jake", cents: 100, status: "approved" },
    ];
    expect(owed(pairwiseDebts(mixed, []), "jake", "amit")).toBe(100);
  });

  it("nets debts in both directions", () => {
    const both: LedgerShare[] = [
      { payerId: "amit", userId: "jake", cents: 2000, status: "approved" },
      { payerId: "jake", userId: "amit", cents: 1500, status: "approved" },
    ];
    expect(pairwiseDebts(both, [])).toEqual([{ fromId: "jake", toId: "amit", cents: 500 }]);
  });

  it("subtracts confirmed, held and released payments but not pending/failed ones", () => {
    const debts = pairwiseDebts(shares, [
      { fromId: "jake", toId: "amit", cents: 2000, status: "confirmed" },
      { fromId: "jake", toId: "priya", cents: 1000, status: "held" },
      { fromId: "sam", toId: "priya", cents: 3200, status: "pending" },
      { fromId: "sam", toId: "priya", cents: 3200, status: "failed" },
    ]);
    expect(owed(debts, "jake", "amit")).toBe(0);
    expect(owed(debts, "jake", "priya")).toBe(2200);
    expect(owed(debts, "sam", "priya")).toBe(3200);
  });

  it("net balances sum to zero and simplify settles everyone", () => {
    const net = netBalances(pairwiseDebts(shares, []));
    expect([...net.values()].reduce((a, b) => a + b, 0)).toBe(0);
    const transfers = simplify(net);
    expect(transfers.length).toBeLessThanOrEqual(net.size - 1);
    const after = new Map(net);
    for (const t of transfers) {
      after.set(t.fromId, after.get(t.fromId)! + t.cents);
      after.set(t.toId, after.get(t.toId)! - t.cents);
    }
    expect([...after.values()].every((v) => v === 0)).toBe(true);
  });
});

describe("validate", () => {
  it("rejects 'pay me $20' with no reason and no receipt", () => {
    expect(validateExpense({ totalCents: 2000 }, [])).toEqual({ ok: false, problem: "missing_reason" });
  });

  it("flags text-only expenses as no_receipt", () => {
    expect(validateExpense({ reason: "firewood", totalCents: 3000 }, [])).toEqual({ ok: true, totalCents: 3000, flags: ["no_receipt"] });
  });

  it("uses the merchant as the reason and the receipt total as the amount", () => {
    const r = validateExpense({ receipt: { totalCents: 8000, merchant: "Shell" } }, []);
    expect(r).toEqual({ ok: true, totalCents: 8000, flags: [] });
  });

  it("flags amount mismatches beyond the larger of $1 or 5%", () => {
    const receipt = { totalCents: 8000, merchant: "Shell" };
    expect(validateExpense({ reason: "gas", totalCents: 8350, receipt }, [])).toMatchObject({ ok: true, flags: [] }); // $3.50 < 5% ($4)
    expect(validateExpense({ reason: "gas", totalCents: 9000, receipt }, [])).toMatchObject({ ok: true, flags: ["amount_mismatch"] });
    expect(validateExpense({ reason: "snacks", totalCents: 650, receipt: { totalCents: 500 } }, [])).toMatchObject({ flags: ["amount_mismatch"] });
  });

  it("flags duplicate receipts by hash or merchant+total+date", () => {
    const history = [{ receiptHash: "abc", merchant: "Shell", receiptTotalCents: 8000, receiptDate: "2026-10-11" }];
    expect(validateExpense({ reason: "gas", receipt: { hash: "abc", totalCents: 8000 } }, history)).toMatchObject({ flags: ["possible_duplicate"] });
    expect(validateExpense({ reason: "gas", receipt: { hash: "zzz", merchant: "shell ", totalCents: 8000, date: "2026-10-11" } }, history)).toMatchObject({ flags: ["possible_duplicate"] });
    expect(validateExpense({ reason: "gas", receipt: { hash: "zzz", merchant: "Shell", totalCents: 8000, date: "2026-10-12" } }, history)).toMatchObject({ flags: [] });
  });
});

describe("approvals", () => {
  const now = 1_000_000;
  const pending = { userId: "jake", status: "pending" as const, autoApproveAt: now + 10, approvedVia: null };

  it("approves the payer's own share and leaves others pending", () => {
    expect(initialShare({ userId: "amit", payerId: "amit", hasReceipt: false, now })).toMatchObject({ status: "approved", approvedVia: "payer" });
    expect(initialShare({ userId: "jake", payerId: "amit", hasReceipt: true, now, autoApproveMs: 50 })).toMatchObject({ status: "pending", autoApproveAt: now + 50 });
  });

  it("never sets auto-approval without a receipt", () => {
    expect(initialShare({ userId: "jake", payerId: "amit", hasReceipt: false, now }).autoApproveAt).toBeNull();
  });

  it("only lets the owner approve or dispute", () => {
    expect(transition(pending, { type: "approve", actorId: "amit", via: "reply" }, now)).toEqual({ ok: false, error: "not_owner" });
    expect(transition(pending, { type: "dispute", actorId: "priya", reason: "no" }, now)).toEqual({ ok: false, error: "not_owner" });
    expect(transition(pending, { type: "approve", actorId: "jake", via: "reply" }, now)).toMatchObject({ ok: true, patch: { status: "approved", approvedVia: "reply" } });
    expect(transition(pending, { type: "dispute", actorId: "jake", reason: "wasn't $80" }, now)).toMatchObject({ ok: true, patch: { status: "disputed", disputeReason: "wasn't $80" } });
  });

  it("auto-approves only when due and only with a receipt", () => {
    expect(transition(pending, { type: "auto_approve" }, now)).toEqual({ ok: false, error: "not_due" });
    expect(transition(pending, { type: "auto_approve" }, now + 10)).toMatchObject({ ok: true, patch: { status: "approved", approvedVia: "auto" } });
    expect(transition({ ...pending, autoApproveAt: null }, { type: "auto_approve" }, now + 999)).toEqual({ ok: false, error: "no_receipt" });
    expect(transition({ ...pending, status: "disputed" }, { type: "auto_approve" }, now + 999)).toEqual({ ok: false, error: "not_pending" });
  });

  it("resets on edit but never touches the payer's share, and rejected is final", () => {
    const approved = { ...pending, status: "approved" as const, approvedVia: "reply" as const };
    expect(transition(approved, { type: "reset" }, now)).toMatchObject({ ok: true, patch: { status: "pending" } });
    expect(transition({ ...approved, approvedVia: "payer" }, { type: "reset" }, now)).toEqual({ ok: false, error: "not_pending" });
    expect(transition({ ...pending, status: "rejected" }, { type: "approve", actorId: "jake", via: "reply" }, now)).toEqual({ ok: false, error: "already_final" });
  });
});
