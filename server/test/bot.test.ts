import { beforeEach, describe, expect, it } from "vitest";
import { parseCommand, parseFixReply, sameDescription } from "../src/bot/commands";
import { groupDebts } from "../src/ledger/debts";
import { owed } from "../src/ledger/settle";
import { expensesOf } from "../src/store/expenses";
import { getGroupByCode } from "../src/store/groups";
import { getUserByPhone } from "../src/store/users";
import { sendReminders } from "../src/jobs";
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
    expect(parseCommand("nope, I didn't eat")).toEqual({ type: "dispute", number: undefined, reason: "I didn't eat" });
    expect(parseCommand("not mine")).toEqual({ type: "dispute", number: undefined, reason: "" });
    expect(parseCommand("no worries")).toBeUndefined(); // plain "no" isn't a flag
    expect(parseCommand("remove")).toEqual({ type: "withdraw" });
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

describe("dispute reply parsing", () => {
  it("reads natural new-amount replies", () => {
    expect(parseFixReply("$30 is fine")).toBe(3000);
    expect(parseFixReply("make it 40")).toBe(4000);
    expect(parseFixReply("change it to $40.50")).toBe(4050);
    expect(parseFixReply("40 works")).toBe(4000);
    expect(parseFixReply("ok 30")).toBe(3000);
    expect(parseFixReply("let's do 25")).toBe(2500);
    expect(parseFixReply("fine, $35 then")).toBe(3500);
    expect(parseFixReply("paid $30 for gas")).toBeUndefined();
    expect(parseFixReply("see you at 5 tomorrow by the lake")).toBeUndefined();
  });

  it("matches expense names loosely", () => {
    expect(sameDescription("Fortnite lessons", "fixed amount fortnite lessons")).toBe(true);
    expect(sameDescription("Fortnite lessons", "Fortnite lesson")).toBe(true);
    expect(sameDescription("Gas", "gas money")).toBe(true);
    expect(sameDescription("Snacks", "Dinner")).toBe(false);
  });
});

describe("Asheville trip, end to end over DMs", () => {
  let bot: ReturnType<typeof makeBot>;
  let code: string;
  const group = () => getGroupByCode(bot.ctx, code)!;
  const id = (who: keyof typeof PHONES) => getUserByPhone(bot.ctx, PHONES[who])!.id;
  const activeExpenses = () => expensesOf(bot.ctx, group().id).filter((e) => e.status === "active");

  beforeEach(async () => {
    bot = makeBot();
    const created = await bot.say("amit", "new trip Asheville");
    expect(created).toContain("Asheville Trip created!");
    code = created.match(/JOIN ([A-Z0-9]+)/)![1]!;
    expect(created).toContain(`Join our Asheville Trip tab 👉 http://localhost:3000/j/${code}`);
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
    expect(group().name).toBe("Asheville Trip");
    for (const phone of Object.values(PHONES)) {
      const u = getUserByPhone(bot.ctx, phone)!;
      expect(u.activeGroupId).toBe(group().id);
      expect(u.walletPubkey).toBeTruthy();
    }
  });

  it("logs a receipt, counts it right away, and gives everyone a heads-up with their running total", async () => {
    const logged = await bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 8000, merchant: "Shell", date: "2026-10-11" })]);
    expect(logged).toContain("Logged to Asheville Trip: Gas $80.00 · split 4 ways ($20.00 each) · 🧾 receipt matched");
    expect(logged).toContain("I let Jake, Priya and Sam know. Running total: you're owed $60.00.");

    const notice = bot.read("jake");
    expect(notice).toContain("Amit logged Gas $80.00 (🧾 receipt matched) for Asheville Trip.");
    expect(notice).toContain("Your share: $20.00 · Running total: you owe $20.00.");
    expect(notice).toContain('Not right? Reply NOPE and what\'s off (like "nope, I didn\'t eat").');
    expect(notice).not.toMatch(/DISPUTE|Reply YES|approve/i);
    expect(notice).not.toMatch(/PAY|Apple Pay/); // nobody is asked to pay when an expense is logged

    // It already counts: no YES needed.
    expect(owed(groupDebts(bot.ctx, group().id), id("jake"), id("amit"))).toBe(2000);
    expect(owed(groupDebts(bot.ctx, group().id), id("priya"), id("amit"))).toBe(2000);
  });

  it("keeps a running total across expenses", async () => {
    await bot.say("amit", "paid $40 for gas, everyone");
    bot.read("jake");
    await bot.say("priya", "paid $96 for dinner, split with jake and sam");
    expect(bot.read("jake")).toContain("Your share: $32.00 · Running total: you owe $42.00.");
    await bot.say("jake", "paid $30 for snacks, everyone");
    expect(bot.read("amit")).toContain("Running total: you're owed $22.50."); // $30 from gas minus $7.50 snacks
  });

  it("forwards the receipt photo right before each heads-up", async () => {
    await bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 8000, merchant: "Shell" })]);
    for (const who of ["jake", "priya", "sam"] as const) {
      const msgs = bot.messenger.inbox(PHONES[who]);
      expect(msgs[0]).toBe("[photo: gas-receipt.jpg]");
      expect(msgs[1]).toContain("Amit logged Gas $80.00 (🧾 receipt matched)");
    }
    const photo = bot.messenger.outbox.find((m) => m.to === PHONES.jake && m.image)!.image!;
    expect(JSON.parse(photo.data.toString())).toMatchObject({ totalCents: 8000 });
    expect(bot.messenger.inbox(PHONES.amit).some((m) => m.startsWith("[photo:"))).toBe(false);
  });

  it("doesn't log random pictures, low-confidence receipts, or anything when the AI is down", async () => {
    const real = bot.ctx.extractor;
    const image = fakeReceipt({});
    const withImage = (r: object) => ({
      name: "test",
      extractFromText: (input: Parameters<typeof real.extractFromText>[0]) => real.extractFromText(input),
      extractFromImage: async () => ({ confidence: 0, ...r }) as never,
    });
    bot.ctx.extractor = withImage({ kind: "other" });
    expect(await bot.say("amit", "gas, everyone", [image])).toContain("doesn't look like a receipt, so I didn't log anything");
    bot.ctx.extractor = withImage({ kind: "receipt", totalCents: 8000, confidence: 0.3 });
    expect(await bot.say("amit", "gas, everyone", [image])).toContain("couldn't read the total clearly");
    bot.ctx.extractor = withImage({ kind: "other", unavailable: true });
    expect(await bot.say("amit", "gas, everyone", [image])).toContain("I can't read photos right now");
    bot.ctx.extractor = real;
    expect(groupDebts(bot.ctx, group().id)).toEqual([]);
    expect(bot.read("jake")).toBe("");
  });

  it("forwards a chat screenshot as evidence but still marks it as no receipt", async () => {
    const real = bot.ctx.extractor;
    bot.ctx.extractor = {
      name: "test",
      extractFromText: (input) => real.extractFromText(input),
      extractFromImage: async () => ({ kind: "chat_screenshot", claimedText: "I paid $640 for the airbnb", confidence: 0.95 }),
    };
    const logged = await bot.say("amit", "split with everyone", [fakeReceipt({}, "screenshot.png")]);
    expect(logged).toContain("Airbnb $640.00");
    expect(logged).toContain("⚠️ no receipt");
    expect(bot.messenger.inbox(PHONES.jake)[0]).toBe("[photo: airbnb-receipt.jpg]");
  });

  it("refuses 'pay me $20' until it has a reason, then logs it with a no-receipt badge", async () => {
    expect(await bot.say("sam", "pay me $30")).toBe("What was the $30.00 for? A receipt photo helps.");
    expect(await bot.say("sam", "firewood")).toContain("Firewood $30.00 · split 4 ways ($7.50 each) · ⚠️ no receipt");
    expect(bot.read("amit")).toContain("Sam logged Firewood $30.00 (⚠️ no receipt)");
  });

  it("asks for a reason even when the extractor (like Gemini) says 'pay me $20' isn't an expense", async () => {
    const real = bot.ctx.extractor;
    bot.ctx.extractor = {
      name: "gemini-like",
      extractFromText: async () => ({ isExpense: false, hasReason: false, amountCents: 2000, participants: "all" }),
      extractFromImage: (input) => real.extractFromImage(input),
    };
    expect(await bot.say("sam", "pay me $20")).toBe("What was the $20.00 for? A receipt photo helps.");
    bot.ctx.extractor = real;
    expect(await bot.say("sam", "gas")).toContain("Gas $20.00");
  });

  it("doesn't treat a much later message as the answer to 'what was it for?'", async () => {
    expect(await bot.say("sam", "pay me $30")).toContain("What was the $30.00 for?");
    bot.advance(20 * 60 * 1000);
    expect(await bot.say("sam", "ok see you soon")).toContain("I didn't catch an expense there.");
  });

  it("splits only between the people named", async () => {
    expect(await bot.say("priya", "paid $96 for dinner, split with jake and sam")).toContain("Dinner $96.00 · split 3 ways ($32.00 each)");
    expect(bot.read("amit")).toBe("");
    expect(bot.read("jake")).toContain("Your share: $32.00");
  });

  describe("NOPE: flagging an expense that isn't right", () => {
    beforeEach(async () => {
      expect(await bot.say("priya", "Amit owes me $80 for fortnite lessons")).toContain("Fortnite lessons $80.00 · owed in full");
      expect(bot.read("amit")).toContain("Your share: $80.00 · Running total: you owe $80.00.");
      const r = await bot.say("amit", "nope, I am better than her at Fortnite");
      expect(r).toContain("Got it, I let Priya know. Your $80.00 share of Fortnite lessons is on hold until you two sort it out.");
      expect(r).toContain("Running total: you're all even.");
    });

    it("puts the share on hold and tells the payer in friendly words", () => {
      expect(owed(groupDebts(bot.ctx, group().id), id("amit"), id("priya"))).toBe(0);
      const toPriya = bot.read("priya");
      expect(toPriya).toContain('Amit flagged Fortnite lessons $80.00: "I am better than her at Fortnite"');
      expect(toPriya).toContain('Reply with the new total (like "make it $40"), REMOVE to delete it, or send the receipt.');
      expect(toPriya).not.toMatch(/dispute|withdraw/i);
    });

    it("treats '$30 is fine' as a fix to THAT expense, not a new one", async () => {
      expect(await bot.say("priya", "$30 is fine")).toContain("Updated Fortnite lessons: $30.00");
      expect(activeExpenses()).toHaveLength(1);
      expect(bot.read("amit")).toContain("Priya updated Fortnite lessons to $30.00.");
      expect(owed(groupDebts(bot.ctx, group().id), id("amit"), id("priya"))).toBe(3000); // counts again, no YES needed
    });

    for (const reply of ["make it 40", "change it to $40", "40 works", "ok $40", "fix 40"]) {
      it(`understands "${reply}"`, async () => {
        expect(await bot.say("priya", reply)).toContain("Updated Fortnite lessons: $40.00");
        expect(activeExpenses()).toHaveLength(1);
      });
    }

    it("updates the flagged expense instead of logging a duplicate with the same name", async () => {
      const r = await bot.say("priya", "send amit $40 fixed amount for fortnite lessons");
      expect(r).toContain("That sounds like the flagged Fortnite lessons ($80.00), so I updated it instead of adding a new one.");
      expect(activeExpenses().map((e) => [e.description, e.totalCents])).toEqual([["Fortnite lessons", 4000]]);
    });

    it("lets the payer REMOVE it", async () => {
      expect(await bot.say("priya", "remove")).toContain("Removed Fortnite lessons $80.00");
      expect(bot.read("amit")).toContain("Priya removed Fortnite lessons $80.00. You don't owe anything for it.");
    });

    it("still logs genuinely different expenses normally", async () => {
      expect(await bot.say("priya", "Amit owed me $3 for nuts")).toContain("Nuts $3.00 · owed in full");
      expect(activeExpenses()).toHaveLength(2);
    });

    it("doesn't treat a non-receipt photo as the fix", async () => {
      bot.ctx.extractor = {
        name: "test",
        extractFromText: async () => ({ isExpense: false, hasReason: false, participants: "all" }),
        extractFromImage: async () => ({ kind: "other", confidence: 0 }),
      };
      const r = await bot.say("priya", "fortnite lessons", [fakeReceipt({}, "selfie.jpg")]);
      expect(r).toContain("doesn't look like a receipt");
    });

    it("lets the payer fix it by sending the receipt", async () => {
      expect(await bot.say("priya", "", [fakeReceipt({ totalCents: 8000, merchant: "Fortnite Coach" })])).toContain(
        "Updated Fortnite lessons: $80.00 (🧾 receipt matched)",
      );
      const toAmit = bot.read("amit");
      expect(toAmit).toContain("[photo: fortnite-lessons-receipt.jpg]");
      expect(toAmit).toContain("Priya updated Fortnite lessons and added the receipt above.");
    });

    it("shows flagged expenses in BALANCE for both people", async () => {
      expect(await bot.say("amit", "balance")).toContain("⏸ You flagged Fortnite lessons $80.00 (waiting on Priya).");
      expect(await bot.say("priya", "balance")).toContain("⏸ Your Fortnite lessons $80.00 was flagged.");
    });
  });

  it("lets the person flagging suggest an amount and the payer reply OK", async () => {
    await bot.say("priya", "Amit owes me $80 for fortnite lessons");
    await bot.say("amit", "nope, should be $30, it was one lesson");
    expect(bot.read("priya")).toContain("Amit suggests $30.00. Reply OK to change it to $30.00");
    expect(await bot.say("priya", "ok")).toContain("Updated Fortnite lessons: $30.00");
    expect(bot.read("amit")).toContain("Your share: $30.00");
  });

  it("flags the expense named in the message, not just the latest one", async () => {
    await bot.say("amit", "paid $40 for gas, everyone");
    await bot.say("priya", "paid $60 for groceries, everyone");
    const r = await bot.say("jake", "nope, I wasn't there for the gas");
    expect(r).toContain("share of Gas is on hold");
    expect(bot.read("amit")).toContain("Jake flagged Gas $40.00");
    expect(bot.read("priya")).not.toContain("flagged");
  });

  it("still understands the old DISPUTE wording", async () => {
    await bot.say("amit", "paid $40 for gas, everyone");
    expect(await bot.say("jake", "DISPUTE wasn't there")).toContain("share of Gas is on hold");
  });

  it("only asks people to pay when someone texts SETTLE, then reminds until paid", async () => {
    await bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 8000, merchant: "Shell", date: "2026-10-11" })]);
    await bot.say("priya", "paid $96 for dinner, split with jake and sam");
    await bot.say("sam", "paid $30 for firewood");
    bot.messenger.clearInbox();

    // Hours pass mid-trip: no payment nagging.
    for (let i = 0; i < 5; i++) {
      bot.advance(2 * 60 * 60 * 1000);
      expect(await sendReminders(bot.ctx)).toBe(0);
    }
    expect(bot.read("jake")).toBe("");

    const why = await bot.say("jake", "why do I owe amit");
    expect(why).toContain("You owe Amit $20.00 for Asheville Trip:");
    expect(why).toContain("• $20.00 Gas ($80.00 ÷ 4) · Amit's receipt (Shell)");

    const settled = await bot.say("priya", "SETTLE");
    expect(settled).toContain("Settling up Asheville Trip. I texted everyone their total:");
    expect(settled).toContain("I'll remind anyone who hasn't paid.");
    const jakeSettle = bot.read("jake");
    expect(jakeSettle).toContain("Time to settle up Asheville Trip: you owe Priya $32.00, Amit $20.00 and Sam $7.50.");
    expect(jakeSettle).toContain("Reply PAY to send USDC from your Tab wallet");

    // After SETTLE, reminders start (with backoff).
    expect(await sendReminders(bot.ctx)).toBe(0); // starts the clock
    bot.advance(61 * 60 * 1000);
    expect(await sendReminders(bot.ctx)).toBeGreaterThan(0);
    expect(bot.read("jake")).toContain("⏰ Reminder: Time to settle up Asheville Trip");

    expect(await bot.say("jake", "PAY")).toContain("✅ Sent $59.50 USDC, simulated:");
    expect(bot.read("amit")).toContain("💸 Jake paid you $20.00 (USDC, simulated) for Asheville Trip.");
    expect(await bot.say("jake", "balance")).toContain("You're all settled up.");
    expect(owed(groupDebts(bot.ctx, group().id), id("sam"), id("amit"))).toBe(1250);
    expect(await bot.say("jake", "PAY")).toBe("You don't owe anyone in Asheville Trip right now.");
  });

  it("YES just shows your running total now (nothing to approve)", async () => {
    await bot.say("amit", "paid $40 for gas, everyone");
    expect(await bot.say("jake", "yes")).toBe("👍 Asheville Trip: you owe $10.00.");
  });

  it("ignores non-expenses and welcomes strangers", async () => {
    expect(await bot.say("jake", "lol see you guys tomorrow")).toContain("I didn't catch an expense there.");
    const stranger = makeBot();
    expect(await stranger.say("amit", "paid $10 for coffee")).toContain("Start a group: text NEW");
  });
});
