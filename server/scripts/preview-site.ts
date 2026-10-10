/**
 * Preview the public pages with fake data (no Photon/Stripe calls), for design work.
 *
 *   npm run preview:site     then open http://localhost:3994
 *     /         landing page
 *     /error    landing page with a validation error
 *     /started  "your Tab number" page
 *     /tab      "your tab" summary page (also /tab-owe)
 *     /t/preview/card.png   the iMessage preview card
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import QRCode from "qrcode";
import { landingPage, startedPage } from "../src/web/landing";
import { renderTabCard } from "../src/web/card";
import { tabPage } from "../src/web/tab-page";
import type { TabSummary } from "../src/bot/summary";

const PORT = Number(process.env.PREVIEW_PORT ?? 3994);
const qrSvg = await QRCode.toString("https://tab.example", { type: "svg", margin: 1, color: { dark: "#0b3550", light: "#ffffff" } });
const app = new Hono();
app.get("/", (c) => c.html(landingPage({ messagingEnabled: true, qrSvg })));
app.get("/error", (c) =>
  c.html(landingPage({ messagingEnabled: true, qrSvg, name: "Amit", phone: "555", error: "Enter your full iPhone number, like (919) 555-1234." })),
);
app.get("/started", (c) => c.html(startedPage({ name: "Amit", line: "+14156055838", qrSvg })));

// Fake tab for designing the summary page + iMessage card.
const now = Date.now();
const fake: TabSummary = {
  group: { id: "g", name: "Asheville Trip", kind: "trip", joinCode: "ASHEV42", organizerId: "u1", settleRequestedAt: null, closedAt: null, createdAt: now },
  user: { id: "u1", phone: "+19195550001", displayName: "Amit", activeGroupId: "g", photonLine: "+14156055838", walletPubkey: null, walletSecretEnc: null, stripeAccountId: null, stripePayoutsEnabled: false, verifiedAt: null, createdAt: now },
  net: 4000,
  paidCents: 9000,
  yourShareCents: 5000,
  flaggedCount: 1,
  people: [
    { id: "u2", name: "Jake", youOwedThem: 0, theyOwedYou: 3000, paidThem: 0, paidYou: 0, net: 3000 },
    { id: "u3", name: "Priya", youOwedThem: 2000, theyOwedYou: 3000, paidThem: 0, paidYou: 0, net: 1000 },
  ],
  expenses: [
    { id: "e3", description: "Firewood", totalCents: 3000, payerName: "Sam", youPaid: false, yourShare: 750, status: "flagged", flags: ["no_receipt"], hasReceipt: false, createdAt: now, today: true },
    { id: "e2", description: "Dinner", totalCents: 6000, payerName: "Priya", youPaid: false, yourShare: 2000, status: "counted", flags: ["no_receipt"], hasReceipt: false, createdAt: now, today: true },
    { id: "e1", description: "Gas", totalCents: 9000, payerName: "You", youPaid: true, yourShare: 3000, status: "counted", flags: [], hasReceipt: true, createdAt: now - 86_400_000, today: false },
  ],
};
app.get("/tab", (c) => c.html(tabPage({ summary: fake, token: "preview", publicBaseUrl: `http://localhost:${PORT}`, payLinks: [], line: "+14156055838" })));
app.get("/tab-owe", (c) =>
  c.html(tabPage({ summary: { ...fake, net: -5000, people: fake.people.map((p) => ({ ...p, net: -p.net })) }, token: "preview", publicBaseUrl: `http://localhost:${PORT}`, payLinks: [{ name: "Jake", cents: 3000, url: "#" }], line: "+14156055838" })),
);
app.get("/t/preview/card.png", async (c) => c.body(new Uint8Array(await renderTabCard(fake)), 200, { "content-type": "image/png" }));
serve({ fetch: app.fetch, port: PORT });
console.log(`Preview: http://localhost:${PORT}  (also /error, /started, /tab, /tab-owe, /t/preview/card.png)`);
