import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app";
import { autoApprove, sendReminders } from "../src/jobs";
import { payLinkUrl } from "../src/payments/service";
import { getShare, userSharesInGroup } from "../src/store/expenses";
import { getGroupByCode } from "../src/store/groups";
import { getUserByPhone } from "../src/store/users";
import { fakeReceipt, makeBot, PHONES, type Person } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

async function setupTrip() {
  const bot = makeBot();
  const created = await bot.say("amit", "new trip Asheville");
  const code = created.match(/JOIN ([A-Z0-9]+)/)![1]!;
  await bot.say("amit", "Amit");
  await bot.say("jake", `JOIN ${code} - I'm Jake`);
  await bot.say("priya", `JOIN ${code} - I'm Priya`);
  bot.messenger.clearInbox();
  const group = getGroupByCode(bot.ctx, code)!;
  const user = (p: Person) => getUserByPhone(bot.ctx, PHONES[p])!;
  return { bot, group, user, app: createApp(bot.ctx) };
}

async function login(t: Awaited<ReturnType<typeof setupTrip>>, who: Person): Promise<string> {
  const start = await t.app.request("/auth/start", { method: "POST", body: JSON.stringify({ phone: PHONES[who] }), headers: { "content-type": "application/json" } });
  expect(start.status).toBe(200);
  const code = [...t.bot.read(who).matchAll(/code is (\d{6})/g)].at(-1)![1]!; // newest code
  const verify = await t.app.request("/auth/verify", { method: "POST", body: JSON.stringify({ phone: PHONES[who], code }), headers: { "content-type": "application/json" } });
  expect(verify.status).toBe(200);
  return ((await verify.json()) as { token: string }).token;
}

const authed = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
});

describe("extension API", () => {
  let t: Awaited<ReturnType<typeof setupTrip>>;
  beforeEach(async () => {
    t = await setupTrip();
  });

  it("logs in with a code texted through the bot, and rejects bad codes and missing tokens", async () => {
    expect((await t.app.request("/api/me")).status).toBe(401);
    await t.app.request("/auth/start", { method: "POST", body: JSON.stringify({ phone: PHONES.jake }), headers: { "content-type": "application/json" } });
    const bad = await t.app.request("/auth/verify", { method: "POST", body: JSON.stringify({ phone: PHONES.jake, code: "000000" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    t.bot.advance(60_000);
    const token = await login(t, "jake");
    const me = await t.app.request("/api/me", authed(token));
    expect(((await me.json()) as { user: { name: string } }).user.name).toBe("Jake");
    const groups = (await (await t.app.request("/api/groups", authed(token))).json()) as { groups: { name: string }[] };
    expect(groups.groups.map((g) => g.name)).toEqual(["Asheville Trip"]);
  });

  it("only lets you flag your own share", async () => {
    await t.bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 9000, merchant: "Shell" })]);
    const jakeToken = await login(t, "jake");
    const shareOf = (who: "jake" | "priya") => userSharesInGroup(t.bot.ctx, t.user(who).id, t.group.id)[0]!.share;

    const forbidden = await t.app.request(`/api/shares/${shareOf("priya").id}/dispute`, authed(jakeToken, { method: "POST", body: JSON.stringify({ reason: "nah" }) }));
    expect(forbidden.status).toBe(403);
    expect(getShare(t.bot.ctx, shareOf("priya").id)!.status).toBe("approved");

    const ok = await t.app.request(`/api/shares/${shareOf("jake").id}/dispute`, authed(jakeToken, { method: "POST", body: JSON.stringify({ reason: "I didn't ride" }) }));
    expect(ok.status).toBe(200);
    expect(getShare(t.bot.ctx, shareOf("jake").id)!.status).toBe("disputed");
    expect(t.bot.read("amit")).toContain('Jake flagged Gas $90.00: "I didn\'t ride"');
  });

  it("flags exactly the share you picked, not just the latest one", async () => {
    await t.bot.say("amit", "paid $30 for snacks");
    await t.bot.say("priya", "paid $60 for groceries");
    const jakeToken = await login(t, "jake");
    const mine = userSharesInGroup(t.bot.ctx, t.user("jake").id, t.group.id);
    const snacks = mine.find((d) => d.expense.description === "Snacks");
    const groceries = mine.find((d) => d.expense.description === "Groceries");
    const res = await t.app.request(`/api/shares/${snacks!.share.id}/dispute`, authed(jakeToken, { method: "POST", body: JSON.stringify({ reason: "I wasn't there" }) }));
    expect(res.status).toBe(200);
    expect(getShare(t.bot.ctx, snacks!.share.id)!.status).toBe("disputed");
    expect(getShare(t.bot.ctx, groceries!.share.id)!.status).toBe("approved");
    expect(t.bot.read("amit")).toContain('Jake flagged Snacks $30.00: "I wasn\'t there"');
  });

  it("returns the group view with balances and the expense detail with an audit trail", async () => {
    await t.bot.say("amit", "paid $30 for snacks");
    const token = await login(t, "jake");
    const view = (await (await t.app.request(`/api/groups/${t.group.id}`, authed(token))).json()) as {
      iOwe: { to: string; amount: string }[];
      expenses: { id: string; description: string; myShare: { status: string } }[];
    };
    expect(view.iOwe).toEqual([expect.objectContaining({ to: "Amit", amount: "$10.00" })]);
    expect(view.expenses[0]).toMatchObject({ description: "Snacks", myShare: { status: "approved" } });

    const detail = (await (await t.app.request(`/api/expenses/${view.expenses[0]!.id}`, authed(token))).json()) as { audit: { action: string; actor: string }[] };
    expect(detail.audit.map((a) => `${a.actor}:${a.action}`)).toEqual(["Amit:created"]);

    // Someone outside the group can't see it.
    const strangerToken = await login(t, "sam");
    expect((await t.app.request(`/api/groups/${t.group.id}`, authed(strangerToken))).status).toBe(404);
  });
});

describe("pay page", () => {
  it("shows the breakdown, pays in USDC, and rejects forged or expired links", async () => {
    const t = await setupTrip();
    await t.bot.say("amit", "paid $30 for snacks");
    const url = payLinkUrl(t.bot.ctx, t.group.id, t.user("jake").id, t.user("amit").id);
    const path = new URL(url).pathname;

    const page = await t.app.request(path);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("$10.00");
    expect(body).toContain("Snacks");
    expect(body).toContain("Pay with USDC");

    const paid = await t.app.request(`${path}/usdc`, { method: "POST" });
    expect(await paid.text()).toContain("Sent $10.00 in USDC to Amit");
    expect(t.bot.read("amit")).toContain("💸 Jake paid you $10.00");
    expect(await (await t.app.request(path)).text()).toContain("All paid up");

    expect((await t.app.request(path.slice(0, -3) + "abc")).status).toBe(410);
    t.bot.advance(2 * DAY);
    expect((await t.app.request(path)).status).toBe(410);
  });
});

describe("jobs", () => {
  it("never nags about payments before someone texts SETTLE", async () => {
    const t = await setupTrip();
    await t.bot.say("amit", "paid $30 for snacks");
    t.bot.messenger.clearInbox();
    for (let i = 0; i < 6; i++) {
      t.bot.advance(DAY / 2);
      expect(await sendReminders(t.bot.ctx)).toBe(0);
    }
    expect(t.bot.read("jake")).toBe("");
  });

  it("after SETTLE, reminds with backoff: starts the clock, reminds after an interval, then waits longer", async () => {
    const t = await setupTrip();
    await t.bot.say("amit", "paid $30 for snacks");
    await t.bot.say("amit", "settle");
    t.bot.messenger.clearInbox();
    const HOUR = 60 * 60 * 1000;

    expect(await sendReminders(t.bot.ctx)).toBe(0); // first sighting: clocks start
    t.bot.advance(HOUR + 1);
    expect(await sendReminders(t.bot.ctx)).toBe(2); // Jake and Priya each owe $10
    expect(t.bot.read("jake")).toContain("⏰ Reminder: Time to settle up Asheville Trip: you owe Amit $10.00");
    t.bot.advance(HOUR + 1);
    expect(await sendReminders(t.bot.ctx)).toBe(0); // backoff: next one is 2h later
    t.bot.advance(HOUR);
    expect(await sendReminders(t.bot.ctx)).toBe(2);

    await t.bot.say("jake", "pay");
    t.bot.advance(10 * HOUR);
    expect(await sendReminders(t.bot.ctx)).toBe(1); // only Priya still owes
  });

  it("has nothing to auto-approve in the running-tab model", async () => {
    const t = await setupTrip();
    const { createExpense } = await import("../src/store/expenses");
    const { expense } = createExpense(t.bot.ctx, {
      groupId: t.group.id,
      payerId: t.user("amit").id,
      description: "Gas",
      totalCents: 2000,
      shares: [{ userId: t.user("amit").id, cents: 1000 }, { userId: t.user("jake").id, cents: 1000 }],
      flags: [],
      receipt: { totalCents: 2000, hash: "abc" },
    });
    expect(expense.id).toBeTruthy();
    expect(await autoApprove(t.bot.ctx)).toBe(0); // nothing pending in the running-tab model
  });
});
