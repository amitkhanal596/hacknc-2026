import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app";
import { registerPhotonUser } from "../src/messaging/photon-users";
import { getGroupByCode, membersOf } from "../src/store/groups";
import { getUserByPhone } from "../src/store/users";
import { makeBot, PHONES } from "./helpers";

const form = (fields: Record<string, string>) => ({
  method: "POST",
  body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded" },
});

async function trip() {
  const bot = makeBot();
  const code = (await bot.say("amit", "new trip Asheville")).match(/\/j\/([A-Z0-9]+)/)![1]!;
  await bot.say("amit", "Amit");
  bot.messenger.clearInbox();
  return { bot, code, app: createApp(bot.ctx) };
}

describe("web join page (the invite link)", () => {
  it("registers the phone with Photon and hands them a pre-filled JOIN text to their own Tab number", async () => {
    const { bot, code, app } = await trip();
    const registered: { phone: string; name?: string | null }[] = [];
    bot.ctx.registerMessagingUser = async (phone, name) => {
      registered.push({ phone, name });
      return { assignedPhoneNumber: "+14155550123" };
    };

    const page = await (await app.request(`/j/${code}`)).text();
    expect(page).toContain("Asheville Trip");
    expect(page).toContain("with Amit");

    const res = await app.request(`/j/${code}`, form({ name: "jake", phone: "(919) 555-0002" }));
    expect(res.status).toBe(200);
    const body = await res.text();
    // The page hands them a pre-filled text to their own Tab number (shared lines need the person to text first).
    expect(body).toContain("Text Tab to join");
    expect(body).toContain(`sms:+14155550123&amp;body=JOIN%20${code}%20-%20I%27m%20jake`);
    expect(registered).toEqual([{ phone: PHONES.jake, name: "jake" }]);
    expect(getUserByPhone(bot.ctx, PHONES.jake)!.photonLine).toBe("+14155550123");
    expect(bot.read("jake")).toBe(""); // the bot doesn't text first

    // They send the pre-filled text; the normal JOIN flow runs.
    await bot.say("jake", `JOIN ${code} - I'm jake`);
    expect(membersOf(bot.ctx, getGroupByCode(bot.ctx, code)!.id).map((m) => m.displayName)).toEqual(["Amit", "Jake"]);
    expect(bot.read("amit")).toContain("👋 Jake joined Asheville Trip.");

    // Re-submitting the form doesn't re-register.
    await app.request(`/j/${code}`, form({ name: "jake", phone: "9195550002" }));
    expect(registered).toHaveLength(1);
  });

  it("joins immediately when there's no Photon (local dev)", async () => {
    const { bot, code, app } = await trip();
    const body = await (await app.request(`/j/${code}`, form({ name: "Sam", phone: "9195550004" }))).text();
    expect(body).toContain("You're in Asheville Trip");
    expect(bot.read("sam")).toContain("You're in Asheville Trip with Amit!");
  });

  it("validates input and shows Photon errors on the page", async () => {
    const { bot, code, app } = await trip();
    expect((await app.request(`/j/${code}`, form({ name: "", phone: "9195550002" }))).status).toBe(422);
    expect(await (await app.request(`/j/${code}`, form({ name: "Sam", phone: "555" }))).text()).toContain("Enter a full phone number");
    bot.ctx.registerMessagingUser = async () => {
      const { PhotonRegistrationError } = await import("../src/messaging/photon-users");
      throw new PhotonRegistrationError("The Photon project is full (free plans cap shared users).", 409);
    };
    expect(await (await app.request(`/j/${code}`, form({ name: "Sam", phone: "9195550004" }))).text()).toContain("project is full");
    expect((await app.request(`/j/NOPE99`)).status).toBe(404);
  });
});

describe("registerPhotonUser", () => {
  it("sends the documented request and returns the assigned line", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ succeed: true, data: { assignedPhoneNumber: "+14155550123" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await registerPhotonUser({ projectId: "proj-1", projectSecret: "s3cret" }, "(919) 555-0002", "Jake", fakeFetch);
    expect(r).toEqual({ assignedPhoneNumber: "+14155550123" });
    expect(seen!.url).toBe("https://spectrum.photon.codes/projects/proj-1/users/");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ type: "shared", phoneNumber: "+19195550002", firstName: "Jake" });
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("proj-1:s3cret").toString("base64")}`);
  });
});
