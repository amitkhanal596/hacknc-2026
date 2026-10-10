import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app";
import { PhotonRegistrationError } from "../src/messaging/photon-users";
import { getUserByPhone } from "../src/store/users";
import { makeBot, PHONES } from "./helpers";

const form = (fields: Record<string, string>, ip = "1.2.3.4") => ({
  method: "POST",
  body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
});

function setup() {
  const bot = makeBot();
  const registered: string[] = [];
  bot.ctx.registerMessagingUser = async (phone) => {
    registered.push(phone);
    return { assignedPhoneNumber: "+14156055838" };
  };
  return { bot, registered, app: createApp(bot.ctx) };
}

describe("home page", () => {
  it("shows the signup form and a QR code for laptops", async () => {
    const { app } = setup();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Get my Tab number");
    expect(page).toContain("<svg"); // QR code
    expect(page).toContain("How it works");
  });

  it("registers the phone and shows the Tab number with text + save-contact buttons", async () => {
    const { bot, registered, app } = setup();
    const page = await (await app.request("/start", form({ name: "Amit", phone: "(919) 555-0001" }))).text();
    expect(registered).toEqual([PHONES.amit]);
    expect(page).toContain("+1 (415) 605-5838");
    expect(page).toContain("sms:+14156055838&amp;body=new%20trip%20");
    expect(page).toContain("/contact.vcf?line=%2B14156055838");
    expect(getUserByPhone(bot.ctx, PHONES.amit)).toMatchObject({ displayName: "Amit", photonLine: "+14156055838" });

    // Signing up again is idempotent: no second registration.
    await app.request("/start", form({ name: "Amit", phone: "9195550001" }));
    expect(registered).toHaveLength(1);
  });

  it("serves a contact card only for Tab numbers we handed out", async () => {
    const { app } = setup();
    expect((await app.request("/contact.vcf?line=%2B14156055838")).status).toBe(404);
    await app.request("/start", form({ name: "Amit", phone: "9195550001" }));
    const res = await app.request("/contact.vcf?line=%2B14156055838");
    expect(res.headers.get("content-type")).toContain("text/vcard");
    expect(await res.text()).toContain("TEL;TYPE=CELL:+14156055838");
  });

  it("validates input, shows Photon errors, and rate-limits signups", async () => {
    const { bot, app } = setup();
    expect(await (await app.request("/start", form({ name: "", phone: "9195550001" }))).text()).toContain("Add your first name");
    expect(await (await app.request("/start", form({ name: "A", phone: "555" }))).text()).toContain("full iPhone number");

    bot.ctx.registerMessagingUser = async () => {
      throw new PhotonRegistrationError("The Photon project is full (free plans cap shared users).", 409);
    };
    expect(await (await app.request("/start", form({ name: "Sam", phone: "9195550004" }, "5.5.5.5"))).text()).toContain("project is full");

    for (let i = 0; i < 5; i++) await app.request("/start", form({ name: "X", phone: `91955510${10 + i}` }, "9.9.9.9"));
    const limited = await app.request("/start", form({ name: "X", phone: "9195551099" }, "9.9.9.9"));
    expect(limited.status).toBe(429);
  });

  it("explains how to try it locally when texting isn't configured", async () => {
    const bot = makeBot();
    const page = await (await createApp(bot.ctx).request("/")).text();
    expect(page).toContain("npm run sim");
    expect(page).not.toContain("Get my Tab number");
  });
});
