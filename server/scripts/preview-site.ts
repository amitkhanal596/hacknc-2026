/**
 * Preview the public pages with fake data (no Photon/Stripe calls), for design work.
 *
 *   npm run preview:site     then open http://localhost:3994
 *     /         landing page
 *     /error    landing page with a validation error
 *     /started  "your Tab number" page
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import QRCode from "qrcode";
import { landingPage, startedPage } from "../src/web/landing";

const PORT = Number(process.env.PREVIEW_PORT ?? 3994);
const qrSvg = await QRCode.toString("https://tab.example", { type: "svg", margin: 1, color: { dark: "#0b3550", light: "#ffffff" } });
const app = new Hono();
app.get("/", (c) => c.html(landingPage({ messagingEnabled: true, qrSvg })));
app.get("/error", (c) =>
  c.html(landingPage({ messagingEnabled: true, qrSvg, name: "Amit", phone: "555", error: "Enter your full iPhone number, like (919) 555-1234." })),
);
app.get("/started", (c) => c.html(startedPage({ name: "Amit", line: "+14156055838", qrSvg })));
serve({ fetch: app.fetch, port: PORT });
console.log(`Preview: http://localhost:${PORT}  (also /error and /started)`);
