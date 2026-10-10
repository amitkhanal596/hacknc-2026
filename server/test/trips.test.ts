import { describe, expect, it } from "vitest";
import { createExtractor } from "../src/ai";
import type { Extractor } from "../src/ai/types";
import { loadConfig } from "../src/config";
import { groupDebts } from "../src/ledger/debts";
import { owed } from "../src/ledger/settle";
import { expensesOf, receiptHistory } from "../src/store/expenses";
import { getGroupByCode } from "../src/store/groups";
import { getUserByPhone } from "../src/store/users";
import { fakeReceipt, makeBot, PHONES } from "./helpers";

/** Amit is in two trips: Asheville (with Jake + Priya) and Apartment 4B (with Sam). */
async function twoTrips() {
  const bot = makeBot();
  const ashe = (await bot.say("amit", "new trip Asheville")).match(/JOIN ([A-Z0-9]+)/)![1]!;
  await bot.say("amit", "Amit");
  await bot.say("jake", `JOIN ${ashe} - I'm Jake`);
  await bot.say("priya", `JOIN ${ashe} - I'm Priya`);
  const created = await bot.say("amit", "new roommates apartment 4b");
  const apt = created.match(/JOIN ([A-Z0-9]+)/)![1]!;
  expect(created).toContain("You're in 2 trips, so add the trip when you text me");
  expect(await bot.say("sam", `JOIN ${apt} - I'm Sam`)).not.toContain("You're in 2 trips");
  bot.messenger.clearInbox();
  const id = (p: keyof typeof PHONES) => getUserByPhone(bot.ctx, PHONES[p])!.id;
  return { bot, ashe: getGroupByCode(bot.ctx, ashe)!, apt: getGroupByCode(bot.ctx, apt)!, id };
}

describe("one trip: just the amount and description", () => {
  it("logs straight to your only trip, no questions", async () => {
    const { bot, ashe, id } = await twoTrips();
    expect(await bot.say("jake", "paid $40 for gas, everyone")).toContain("Logged to Asheville Trip: Gas $40.00");
    expect(owed(groupDebts(bot.ctx, ashe.id), id("amit"), id("jake"))).toBe(1333);
  });
});

describe("more than one trip: confirm which one", () => {
  it("asks which trip, then logs it to the one you pick", async () => {
    const { bot, apt, id } = await twoTrips();
    const q = await bot.say("amit", "paid $40 for gas");
    expect(q).toBe('Which trip is "Gas $40.00" for?\n1) Asheville Trip\n2) Apartment 4B\nReply with the number.');
    expect(expensesOf(bot.ctx, apt.id)).toHaveLength(0); // nothing logged until you pick
    expect(await bot.say("amit", "2")).toContain("Logged to Apartment 4B: Gas $40.00 · split 2 ways ($20.00 each)");
    expect(bot.read("sam")).toContain("Amit logged Gas $40.00");
    expect(bot.read("jake")).toBe(""); // Asheville people aren't involved
    expect(owed(groupDebts(bot.ctx, apt.id), id("sam"), id("amit"))).toBe(2000);
  });

  it("you can answer with the trip name too", async () => {
    const { bot } = await twoTrips();
    await bot.say("amit", "paid $40 for gas");
    expect(await bot.say("amit", "asheville")).toContain("Logged to Asheville Trip: Gas $40.00 · split 3 ways");
  });

  for (const [text, trip, desc] of [
    ["paid $30 for snacks #asheville", "Asheville Trip", "Snacks"],
    ["paid $30 for snacks for the asheville trip", "Asheville Trip", "Snacks"],
    ["apartment: $120 for wifi", "Apartment 4B", "Wifi"],
    ["paid $90 for groceries (apartment)", "Apartment 4B", "Groceries"],
  ] as const) {
    it(`"${text}" names the trip, so it doesn't ask`, async () => {
      const { bot } = await twoTrips();
      expect(await bot.say("amit", text)).toContain(`Logged to ${trip}: ${desc}`);
    });
  }

  it("asks for photos too, then logs the saved receipt with its photo", async () => {
    const { bot, ashe } = await twoTrips();
    const q = await bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 9000, merchant: "Shell" })]);
    expect(q).toContain("Which trip is this photo for?");
    expect(await bot.say("amit", "1")).toContain("Logged to Asheville Trip: Gas $90.00 · split 3 ways ($30.00 each) · 🧾 receipt matched");
    expect(bot.messenger.inbox(PHONES.jake)[0]).toBe("[photo: gas-receipt.jpg]");
    expect(receiptHistory(bot.ctx, ashe.id)[0]!.receiptTotalCents).toBe(9000);
  });

  it("a stale answer doesn't log an old message", async () => {
    const { bot } = await twoTrips();
    await bot.say("amit", "paid $40 for gas");
    bot.advance(31 * 60 * 1000);
    expect(await bot.say("amit", "1")).not.toContain("Logged");
  });

  it("asks which trip for SETTLE / SUMMARY / WHY, unless you name it", async () => {
    const { bot } = await twoTrips();
    await bot.say("amit", "paid $30 for snacks #asheville");
    await bot.say("amit", "paid $40 for wifi #apartment");
    expect(await bot.say("amit", "settle")).toBe("Which trip?\n1) Asheville Trip\n2) Apartment 4B\nReply with the number.");
    expect(await bot.say("amit", "1")).toContain("Settling up Asheville Trip");
    expect(await bot.say("amit", "summary apartment")).toContain("Your Apartment 4B tab: you're owed $20.00.");
    expect(await bot.say("amit", "why asheville")).toContain("Jake owes you $10.00");
  });

  it("BALANCE shows every trip instead of asking", async () => {
    const { bot } = await twoTrips();
    await bot.say("amit", "paid $30 for snacks #asheville");
    await bot.say("amit", "paid $40 for wifi #apartment");
    const b = await bot.say("amit", "balance");
    expect(b).toContain("Asheville Trip:");
    expect(b).toContain("Apartment 4B:");
  });

  it("GROUPS lists each trip with its tag", async () => {
    const { bot } = await twoTrips();
    const g = await bot.say("amit", "groups");
    expect(g).toContain("• Asheville Trip (#asheville)");
    expect(g).toContain("• Apartment 4B (#apartment)");
  });

  it("NOPE still finds the right expense across trips", async () => {
    const { bot } = await twoTrips();
    await bot.say("amit", "paid $40 for wifi #apartment");
    expect(await bot.say("sam", "nope, I don't use the wifi")).toContain("share of Wifi is on hold");
  });
});

describe("END TRIP", () => {
  it("only the organizer can end it, it warns when unsettled, and ended trips stop counting", async () => {
    const { bot, ashe } = await twoTrips();
    await bot.say("amit", "paid $30 for snacks #asheville");
    expect(await bot.say("jake", "end trip")).toBe("Only Amit, who started Asheville Trip, can end it.");
    const warn = await bot.say("amit", "end trip asheville");
    expect(warn).toContain("Asheville Trip isn't settled yet:");
    expect(warn).toContain("reply END TRIP again to close it anyway");
    bot.messenger.clearInbox();
    await bot.say("amit", "end trip");
    expect(bot.read("jake")).toContain("🏁 Amit ended Asheville Trip. Anything still owed can be paid with PAY.");
    expect(getGroupByCode(bot.ctx, ashe.joinCode)!.closedAt).toBeTruthy();
    // Amit is now only in one open trip, so no more questions.
    expect(await bot.say("amit", "paid $12 for paper towels")).toContain("Logged to Apartment 4B");
    // The ended trip's tab can still be viewed and paid.
    expect(await bot.say("jake", "summary asheville")).toContain("Your Asheville Trip tab: you owe $10.00.");
    expect(await bot.say("jake", "pay")).toContain("✅ Sent $10.00");
  });
});

describe("saving Gemini quota", () => {
  function counting() {
    const calls: string[] = [];
    const fake: Extractor = {
      name: "fake-gemini",
      extractFromText: async (input) => {
        calls.push(input.text);
        return { isExpense: true, hasReason: true, reason: "x", amountCents: 100, participants: "all" };
      },
      extractFromImage: async () => ({ kind: "other", confidence: 0 }),
    };
    const ex = createExtractor(loadConfig({} as NodeJS.ProcessEnv), fake);
    const run = (text: string) => ex.extractFromText({ text, senderId: "a", members: [{ id: "a", name: "Amit" }, { id: "j", name: "Jake" }], recent: [] });
    return { calls, run };
  }

  it("simple texts and chit-chat never call Gemini", async () => {
    const { calls, run } = counting();
    await run("paid $80 for gas");
    await run("$45 groceries split with jake");
    await run("covered jake's dinner $20");
    await run("lol see you guys tomorrow");
    await run("ok sounds good");
    expect(calls).toEqual([]);
  });

  it("tricky texts still go to Gemini", async () => {
    const { calls, run } = counting();
    await run("paid 30 for gas and 20 for snacks");
    await run("I paid half of the $80 dinner");
    await run("twenty bucks for the uber");
    expect(calls).toHaveLength(3);
  });
});
