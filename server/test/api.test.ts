import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app";
import { autoApprove, sendReminders } from "../src/jobs";
import { payLinkUrl } from "../src/payments/service";
import { pendingSharesFor, getShare } from "../src/store/expenses";
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

  it("only lets you approve or dispute your own share", async () => {
    await t.bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 9000, merchant: "Shell" })]);
    const jakeToken = await login(t, "jake");
    const priyaShare = pendingSharesFor(t.bot.ctx, t.user("priya").id)[0]!.share;
    const jakeShare = pendingSharesFor(t.bot.ctx, t.user("jake").id)[0]!.share;

    const forbidden = await t.app.request(`/api/shares/${priyaShare.id}/approve`, authed(jakeToken, { method: "POST" }));
    expect(forbidden.status).toBe(403);
    expect(getShare(t.bot.ctx, priyaShare.id)!.status).toBe("pending");

    const ok = await t.app.request(`/api/shares/${jakeShare.id}/approve`, authed(jakeToken, { method: "POST" }));
    expect(ok.status).toBe(200);
    expect(getShare(t.bot.ctx, jakeShare.id)!).toMatchObject({ status: "approved", approvedVia: "extension" });

    const noDispute = await t.app.request(`/api/shares/${priyaShare.id}/dispute`, authed(jakeToken, { method: "POST", body: JSON.stringify({ reason: "nah" }) }));
    expect(noDispute.status).toBe(403);
  });

  it("disputes exactly the share you picked, not just the first pending one", async () => {
    await t.bot.say("amit", "paid $30 for snacks");
    await t.bot.say("priya", "paid $60 for groceries");
    const jakeToken = await login(t, "jake");
    const [first, second] = pendingSharesFor(t.bot.ctx, t.user("jake").id);
    const res = await t.app.request(`/api/shares/${second!.share.id}/dispute`, authed(jakeToken, { method: "POST", body: JSON.stringify({ reason: "I wasn't there" }) }));
    expect(res.status).toBe(200);
    expect(getShare(t.bot.ctx, second!.share.id)!.status).toBe("disputed");
    expect(getShare(t.bot.ctx, first!.share.id)!.status).toBe("pending");
    expect(t.bot.read("priya")).toContain('Jake disputed Groceries $60.00: "I wasn\'t there"');
  });

  it("returns the group view with balances and the expense detail with an audit trail", async () => {
    await t.bot.say("amit", "paid $30 for snacks");
    await t.bot.say("jake", "yes");
    const token = await login(t, "jake");
    const view = (await (await t.app.request(`/api/groups/${t.group.id}`, authed(token))).json()) as {
      iOwe: { to: string; amount: string }[];
      expenses: { id: string; description: string; myShare: { status: string } }[];
    };
    expect(view.iOwe).toEqual([expect.objectContaining({ to: "Amit", amount: "$10.00" })]);
    expect(view.expenses[0]).toMatchObject({ description: "Snacks", myShare: { status: "approved" } });

    const detail = (await (await t.app.request(`/api/expenses/${view.expenses[0]!.id}`, authed(token))).json()) as { audit: { action: string; actor: string }[] };
    expect(detail.audit.map((a) => `${a.actor}:${a.action}`)).toEqual(["Amit:created", "Jake:approved"]);

    // Someone outside the group can't see it.
    const strangerToken = await login(t, "sam");
    expect((await t.app.request(`/api/groups/${t.group.id}`, authed(strangerToken))).status).toBe(404);
  });
});

describe("pay page", () => {
  it("shows the breakdown, pays in USDC, and rejects forged or expired links", async () => {
    const t = await setupTrip();
    await t.bot.say("amit", "paid $30 for snacks");
    await t.bot.say("jake", "yes");
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
  it("auto-approves receipt-backed shares after 24h, never text-only ones", async () => {
    const t = await setupTrip();
    await t.bot.say("amit", "gas, everyone", [fakeReceipt({ totalCents: 9000, merchant: "Shell" })]);
    await t.bot.say("priya", "paid $30 for snacks");
    t.bot.messenger.clearInbox();

    t.bot.advance(DAY - 60_000);
    expect(await autoApprove(t.bot.ctx)).toBe(0);
    t.bot.advance(120_000);
    expect(await autoApprove(t.bot.ctx)).toBe(2); // Jake's + Priya's gas shares
    expect(t.bot.read("jake")).toContain("Auto-approved your $30.00 share of Gas");

    t.bot.advance(30 * DAY);
    expect(await autoApprove(t.bot.ctx)).toBe(0);
    const stillPending = pendingSharesFor(t.bot.ctx, t.user("jake").id).map((p) => p.expense.description);
    expect(stillPending).toEqual(["Snacks"]);
  });

  it("reminds with backoff: starts the clock, reminds after an interval, then waits longer", async () => {
    const t = await setupTrip();
    await t.bot.say("amit", "paid $30 for snacks");
    await t.bot.say("jake", "yes");
    t.bot.messenger.clearInbox();
    const HOUR = 60 * 60 * 1000;

    expect(await sendReminders(t.bot.ctx)).toBe(0); // first sighting: clocks start
    t.bot.advance(HOUR + 1);
    expect(await sendReminders(t.bot.ctx)).toBe(2); // Jake's debt + Priya's pending review
    expect(t.bot.read("jake")).toContain("⏰ Reminder: You owe Amit $10.00");
    expect(t.bot.read("priya")).toContain("⏰ Reminder:");
    t.bot.advance(HOUR + 1);
    expect(await sendReminders(t.bot.ctx)).toBe(0); // backoff: next one is 2h later
    t.bot.advance(HOUR);
    expect(await sendReminders(t.bot.ctx)).toBe(2);
  });
});
