import { beforeEach, describe, expect, it } from "vitest";
import { parseCommand } from "../src/bot/commands";
import { groupDebts } from "../src/ledger/debts";
import { owed } from "../src/ledger/settle";
import { getGroupByCode } from "../src/store/groups";
import { getUserByPhone } from "../src/store/users";
import { fakeReceipt, makeBot, PHONES } from "./helpers";

describe("command parsing", () => {
  it("parses commands and leaves expenses alone", () => {
    expect(parseCommand("new trip Asheville")).toEqual({ type: "new", kind: "trip", name: "Asheville Trip" });
    expect(parseCommand("NEW lake tahoe")).toEqual({ type: "new", kind: "trip", name: "Lake Tahoe Trip" });
    expect(parseCommand("new roommates apt 4b")).toEqual({ type: "new", kind: "roommates", name: "Apt 4b" });
    expect(parseCommand("JOIN ashev42 - I'm Priya")).toEqual({ type: "join", code: "ASHEV42", name: "Priya" });
    expect(parseCommand("join ASHEV42")).toEqual({ type: "join", code: "ASHEV42", name: undefined });
    expect(parseCommand("yes")).toEqual({ type: "yes", all: false, numbers: [] });
    expect(parseCommand("YES ALL")).toEqual({ type: "yes", all: true, numbers: [] });
    expect(parseCommand("yes 1 3")).toEqual({ type: "yes", all: false, numbers: [1, 3] });
    expect(parseCommand("dispute 2 wasn't that much")).toEqual({ type: "dispute", number: 2, reason: "wasn't that much" });
    expect(parseCommand("DISPUTE I don't remember any firewood")).toEqual({ type: "dispute", number: undefined, reason: "I don't remember any firewood" });
    expect(parseCommand("PAY")).toEqual({ type: "pay", who: undefined });
    expect(parseCommand("pay amit")).toEqual({ type: "pay", who: "amit" });
    expect(parseCommand("why do I owe Amit $42?")).toEqual({ type: "why", who: "Amit" });
    expect(parseCommand("fix $70")).toEqual({ type: "fix", cents: 7000 });
    expect(parseCommand("@tab settle")).toEqual({ type: "settle" });
    // Expenses, not commands:
    expect(parseCommand("pay me $20")).toBeUndefined();
    expect(parseCommand("paid $80 for gas")).toBeUndefined();
    expect(parseCommand("dinner 96 split with jake and sam")).toBeUndefined();
  });
});

describe("Asheville trip, end to end over DMs", () => {
  let bot: ReturnType<typeof makeBot>;
  let code: string;

  beforeEach(async () => {
    bot = makeBot();
    const created = await bot.say("amit", "new trip Asheville");
    expect(created).toContain("Asheville Trip created!");
    code = created.match(/JOIN ([A-Z0-9]+)/)![1]!;
    expect(created).toContain(`sms:+15555550100&body=JOIN%20${code}`);
    expect(created).toContain("What should I call you?");
    expect(await bot.say("amit", "Amit")).toContain("Nice to meet you, Amit!");

    expect(await bot.say("jake", `JOIN ${code}`)).toContain("You're in Asheville Trip with Amit!");
    expect(await bot.say("jake", "jake")).toContain("Nice to meet you, Jake!");
    expect(bot.read("amit")).toContain("👋 Jake joined Asheville Trip.");
    await bot.say("priya", `JOIN ${code} - I'm Priya`);
    await bot.say("sam", `join ${code} im sam`);
    bot.messenger.clearInbox();
  });

  it("creates the group and gives everyone a wallet", () => {
    const group = getGroupByCode(bot.ctx, code)!;
    expect(group.name).toBe("Asheville Trip");
    for (const phone of Object.values(PHONES)) {
      const u = getUserByPhone(bot.ctx, phone)!;
      expect(u.activeGroupId).toBe(group.id);
      expect(u.walletPubkey).toBeTruthy();
    }
  });

  it("logs a receipt, asks each person in their own DM, and approves", async () => {
    const logged = await bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 8000, merchant: "Shell", date: "2026-10-11" })]);
    expect(logged).toContain("Logged to Asheville Trip: Gas $80.00 · split 4 ways ($20.00 each) · 🧾 receipt matched");
    expect(logged).toContain("I've asked Jake, Priya and Sam to approve");

    const ask = bot.read("jake");
    expect(ask).toContain("Amit logged Gas $80.00 (🧾 receipt matched) for Asheville Trip. Your share: $20.00.");
    expect(ask).toContain("Reply YES, DISPUTE + reason, or WHY.");

    expect(await bot.say("jake", "YES")).toContain("✅ Approved: Gas (your share $20.00).");
    const group = getGroupByCode(bot.ctx, code)!;
    const jake = getUserByPhone(bot.ctx, PHONES.jake)!;
    const amit = getUserByPhone(bot.ctx, PHONES.amit)!;
    const priya = getUserByPhone(bot.ctx, PHONES.priya)!;
    // Only Jake approved, so only Jake owes anything yet.
    expect(owed(groupDebts(bot.ctx, group.id), jake.id, amit.id)).toBe(2000);
    expect(owed(groupDebts(bot.ctx, group.id), priya.id, amit.id)).toBe(0);
  });

  it("refuses 'pay me $20' until it has a reason, then logs it with a no-receipt badge", async () => {
    expect(await bot.say("sam", "pay me $30")).toBe("What was the $30.00 for? A receipt photo helps.");
    const logged = await bot.say("sam", "firewood");
    expect(logged).toContain("Firewood $30.00 · split 4 ways ($7.50 each) · ⚠️ no receipt");
    expect(bot.read("amit")).toContain("Sam logged Firewood $30.00 (⚠️ no receipt)");
  });

  it("doesn't treat a much later message as the answer to 'what was it for?'", async () => {
    expect(await bot.say("sam", "pay me $30")).toContain("What was the $30.00 for?");
    bot.advance(20 * 60 * 1000);
    expect(await bot.say("sam", "ok see you soon")).toContain("I didn't catch an expense there.");
  });

  it("splits only between the people named", async () => {
    const logged = await bot.say("priya", "paid $96 for dinner, split with jake and sam");
    expect(logged).toContain("Dinner $96.00 · split 3 ways ($32.00 each)");
    expect(bot.read("amit")).toBe(""); // Amit wasn't part of dinner, so he isn't asked.
    expect(bot.read("jake")).toContain("Your share: $32.00");
  });

  it("handles a dispute: the share is frozen, the payer adds a receipt, everyone re-approves", async () => {
    await bot.say("sam", "pay me $30");
    await bot.say("sam", "firewood");
    bot.messenger.clearInbox();

    const disputed = await bot.say("amit", "DISPUTE I don't remember any firewood");
    expect(disputed).toContain("won't count until it's sorted out");
    const toSam = bot.read("sam");
    expect(toSam).toContain('Amit disputed Firewood $30.00: "I don\'t remember any firewood"');
    expect(toSam).toContain("Reply FIX $amount to change the total, WITHDRAW to remove it, or send a receipt photo.");

    const updated = await bot.say("sam", "", [fakeReceipt({ totalCents: 3000, merchant: "Ingles", date: "2026-10-12" })]);
    expect(updated).toContain("Updated Firewood: $30.00 (🧾 receipt matched)");
    expect(bot.read("amit")).toContain("Sam updated Firewood.");
    expect(await bot.say("amit", "yes")).toContain("✅ Approved: Firewood");
  });

  it("lets the payer withdraw a disputed expense", async () => {
    await bot.say("sam", "paid $30 for firewood");
    await bot.say("amit", "dispute nope");
    expect(await bot.say("sam", "withdraw")).toContain("Removed Firewood $30.00");
    expect(bot.read("jake")).toContain("Sam removed Firewood $30.00. You don't owe anything for it.");
  });

  it("runs the whole trip: approvals, WHY, SETTLE, and PAY", async () => {
    await bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 8000, merchant: "Shell", date: "2026-10-11" })]);
    await bot.say("priya", "paid $96 for dinner, split with jake and sam");
    await bot.say("sam", "paid $30 for firewood");

    // Jake has three things waiting; they come as one numbered list.
    const list = bot.read("jake").split("\n---\n").at(-1)!;
    expect(list).toContain("You have 3 expenses waiting for your OK:");
    expect(list).toContain("Reply YES ALL, YES 1 3, or DISPUTE 2 + reason.");

    expect(await bot.say("jake", "yes")).toContain("Which ones?");
    expect(await bot.say("jake", "YES ALL")).toContain("✅ Approved: Gas (your share $20.00), Dinner (your share $32.00) and Firewood (your share $7.50).");
    await bot.say("priya", "yes all");
    await bot.say("sam", "yes all");
    expect(bot.read("amit")).toContain("✅ Everyone approved Gas $80.00 in Asheville Trip.");
    expect(await bot.say("amit", "yes")).toContain("Firewood");

    const why = await bot.say("jake", "why do I owe amit");
    expect(why).toContain("You owe Amit $20.00 for Asheville Trip:");
    expect(why).toContain("• $20.00 Gas ($80.00 ÷ 4) · Amit's receipt (Shell)");
    expect(why).toContain("you approved");

    const fullWhy = await bot.say("jake", "WHY");
    expect(fullWhy).toContain("You owe Priya $32.00");
    expect(fullWhy).toContain('Priya texted "paid $96 for dinner, split with jake and sam"');
    expect(fullWhy).toContain("You owe Sam $7.50");

    const settled = await bot.say("priya", "SETTLE");
    expect(settled).toContain("Sent settle-up texts for Asheville Trip:");
    const jakeSettle = bot.read("jake");
    expect(jakeSettle).toContain("You owe Priya $32.00, Amit $20.00 and Sam $7.50 for Asheville Trip.");
    expect(jakeSettle).toContain("Reply PAY to send USDC from your Tab wallet");
    expect(jakeSettle).not.toContain("Apple Pay"); // Stripe isn't configured in this test.

    const paid = await bot.say("jake", "PAY");
    expect(paid).toContain("✅ Sent $59.50 USDC, simulated:");
    expect(bot.read("amit")).toContain("💸 Jake paid you $20.00 (USDC, simulated) for Asheville Trip.");
    expect(await bot.say("jake", "balance")).toContain("You're all settled up.");

    // Sam owes Amit $20 for gas minus Amit's $7.50 firewood share.
    const group = getGroupByCode(bot.ctx, code)!;
    const sam = getUserByPhone(bot.ctx, PHONES.sam)!;
    const amit = getUserByPhone(bot.ctx, PHONES.amit)!;
    expect(owed(groupDebts(bot.ctx, group.id), sam.id, amit.id)).toBe(1250);

    // Paying twice does nothing.
    expect(await bot.say("jake", "PAY")).toBe("You don't owe anyone in Asheville Trip right now.");
  });

  it("does not let anyone approve someone else's share", async () => {
    await bot.say("amit", "paid $40 for snacks");
    // Amit has nothing pending himself; his YES can't touch Jake's share.
    expect(await bot.say("amit", "yes all")).toBe("Nothing is waiting on your OK right now.");
    const group = getGroupByCode(bot.ctx, code)!;
    expect(groupDebts(bot.ctx, group.id)).toEqual([]);
  });

  it("ignores non-expenses and welcomes strangers", async () => {
    expect(await bot.say("jake", "lol see you guys tomorrow")).toContain("I didn't catch an expense there.");
    const stranger = makeBot();
    expect(await stranger.say("amit", "paid $10 for coffee")).toContain("Start a group: text NEW");
  });
});
