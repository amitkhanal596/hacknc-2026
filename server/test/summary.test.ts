import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app";
import { parseCommand } from "../src/bot/commands";
import { buildSummary } from "../src/bot/summary";
import { groupDebts } from "../src/ledger/debts";
import { getGroupByCode } from "../src/store/groups";
import { getUserByPhone } from "../src/store/users";
import { fakeReceipt, makeBot, PHONES } from "./helpers";

async function trip() {
  const bot = makeBot();
  const code = (await bot.say("amit", "new trip Asheville")).match(/JOIN ([A-Z0-9]+)/)![1]!;
  await bot.say("amit", "Amit");
  await bot.say("jake", `JOIN ${code} - I'm Jake`);
  await bot.say("priya", `JOIN ${code} - I'm Priya`);
  bot.messenger.clearInbox();
  const group = getGroupByCode(bot.ctx, code)!;
  const user = (p: keyof typeof PHONES) => getUserByPhone(bot.ctx, PHONES[p])!;
  return { bot, group, user, app: createApp(bot.ctx) };
}

describe("asking for your tab", () => {
  it("understands the natural ways people ask", () => {
    for (const t of ["hey what are my expenses", "what are my expenses?", "summary", "my tab", "show me my tab", "recap", "where do I stand?", "what's my running total", "Tab", "expenses today"]) {
      expect(parseCommand(t), t).toEqual({ type: "summary" });
    }
    expect(parseCommand("paid $20 for my expenses")).toBeUndefined();
  });

  it("replies with a short summary, then a rich link card", async () => {
    const { bot } = await trip();
    await bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 9000, merchant: "Shell" })]);
    await bot.say("priya", "paid $60 for dinner, split with amit and jake");
    bot.messenger.clearInbox();
    await bot.messenger.receive(PHONES.amit, "hey what are my expenses");
    const msgs = bot.messenger.inbox(PHONES.amit);
    expect(msgs[0]).toContain("Your Asheville Trip tab: you're owed $40.00.");
    expect(msgs[0]).toContain("Jake owes you $30.00");
    expect(msgs[0]).toContain("Priya: you owed $20.00, they owed you $30.00 → Priya owes you $10.00");
    expect(msgs[0]).toContain("Today: Gas $30.00, Dinner $20.00.");
    expect(msgs[0]).toContain("You've paid $90.00 so far · your share of everything is $50.00.");
    expect(msgs[1]).toMatch(/^\[link: http:\/\/localhost:3000\/t\/[\w-]+\.[\w-]+\]$/);
  });
});

describe("netting: when two people owe each other, only the difference is paid", () => {
  it("person 1 owes $20, person 2 owes $25 → person 2 pays $5", async () => {
    const { bot, group, user } = await trip();
    await bot.say("amit", "Jake owes me $25 for tickets"); // Jake owes Amit $25
    await bot.say("jake", "Amit owes me $20 for gas"); // Amit owes Jake $20
    expect(groupDebts(bot.ctx, group.id)).toEqual([{ fromId: user("jake").id, toId: user("amit").id, cents: 500 }]);

    const amit = buildSummary(bot.ctx, user("amit"), group);
    expect(amit.people[0]).toMatchObject({ name: "Jake", youOwedThem: 2000, theyOwedYou: 2500, net: 500 });

    bot.messenger.clearInbox();
    expect(await bot.say("jake", "settle")).toContain("you owe Amit $5.00"); // one $5 payment, not $20 + $25
    expect(bot.read("amit")).not.toContain("you owe");
  });
});

describe("tab page and card", () => {
  it("serves the page with iMessage preview tags, and a real PNG card", async () => {
    const { bot, app } = await trip();
    await bot.say("amit", "paid $90 for gas, everyone");
    const url = (await bot.say("amit", "summary")).match(/\[link: (.+)\]/)![1]!;
    const path = new URL(url).pathname;

    const page = await (await app.request(path)).text();
    expect(page).toContain('property="og:title" content="Amit&#39;s tab · Asheville Trip"');
    expect(page).toContain('property="og:image" content="http://localhost:3000' + path + '/card.png"');
    expect(page).toContain("Running total");
    expect(page).toContain("$60.00");
    expect(page).toContain("Jake owes you $30.00");
    expect(page).toContain("Gas");

    const card = await app.request(`${path}/card.png`);
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await card.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); // PNG signature
    expect(bytes.length).toBeGreaterThan(10_000);

    expect((await app.request("/t/not.valid")).status).toBe(410);
    bot.advance(31 * 24 * 60 * 60 * 1000);
    expect((await app.request(path)).status).toBe(410);
  }, 20_000);

  it("shows Jake who to pay, with Apple Pay links when Stripe is on", async () => {
    const { bot, app } = await trip();
    bot.ctx.stripe = { publishableKey: "pk_test_x" } as never;
    await bot.say("amit", "paid $90 for gas, everyone");
    const url = (await bot.say("jake", "my tab")).match(/\[link: (.+)\]/)![1]!;
    const page = await (await app.request(new URL(url).pathname)).text();
    expect(page).toContain("You owe this overall.");
    expect(page).toContain("Apple Pay Amit $30.00");
  });
});
