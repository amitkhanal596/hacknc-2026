import { html, raw } from "hono/html";

/**
 * The public home page: a Frutiger Aero-style landing page where an organizer
 * gets their Tab number (we register their phone with Photon and show the
 * shared-pool line they should text).
 */

const STYLE = `
  :root {
    color-scheme: light;
    --sky-top: #3fb4f0; --sky-mid: #8fd8fb; --sky-low: #e4f7ff;
    --ink: #0b3550; --ink-soft: #3d6680; --glass: rgba(255,255,255,.62);
    --aqua-1: #9bf06f; --aqua-2: #3cb52a; --aqua-edge: #2b8a1d;
    --blue-1: #6fd0ff; --blue-2: #1590d6;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    font: 17px/1.5 "Segoe UI", "Frutiger", "Myriad Pro", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
    color: var(--ink);
    background: linear-gradient(180deg, var(--sky-top) 0%, var(--sky-mid) 42%, var(--sky-low) 78%, #f6fff0 100%);
    background-attachment: fixed;
    overflow-x: hidden;
  }

  /* Soft sun glow + light rays */
  .sun { position: fixed; top: -180px; right: -140px; width: 520px; height: 520px; border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,.95) 0%, rgba(255,255,255,.45) 30%, rgba(255,255,255,0) 68%);
    pointer-events: none; z-index: 0; }
  .rays { position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: .35;
    background: repeating-conic-gradient(from 200deg at 92% -5%, rgba(255,255,255,.55) 0deg 4deg, rgba(255,255,255,0) 4deg 13deg);
    mask-image: radial-gradient(circle at 92% 0%, #000 0%, transparent 60%);
    -webkit-mask-image: radial-gradient(circle at 92% 0%, #000 0%, transparent 60%); }

  /* Floating glossy bubbles */
  .bubbles { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }
  .bubble { position: absolute; bottom: -120px; border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, rgba(255,255,255,.95) 0 8%, rgba(255,255,255,.35) 22%, rgba(140,215,255,.18) 55%, rgba(255,255,255,.4) 100%);
    border: 1px solid rgba(255,255,255,.7);
    box-shadow: inset -6px -8px 18px rgba(30,140,210,.18), 0 4px 18px rgba(0,90,160,.10);
    animation: rise linear infinite; }
  @keyframes rise { from { transform: translateY(0) translateX(0); } 50% { transform: translateY(-55vh) translateX(18px); } to { transform: translateY(-115vh) translateX(-10px); } }
  @media (prefers-reduced-motion: reduce) { .bubble { animation: none; display: none; } }

  /* Grassy hill */
  .hill { position: fixed; left: 0; right: 0; bottom: 0; height: 200px; z-index: 0; pointer-events: none; }

  main { position: relative; z-index: 1; max-width: 480px; margin: 0 auto; padding: 28px 16px 210px; }

  /* Logo orb */
  .brand { display: flex; align-items: center; gap: 14px; margin: 8px 4px 22px; }
  .orb { width: 64px; height: 64px; border-radius: 50%; flex: none; position: relative;
    background: radial-gradient(circle at 50% 120%, #7ff0ff 0%, var(--blue-1) 35%, var(--blue-2) 75%, #0b5f99 100%);
    box-shadow: 0 8px 22px rgba(0,80,150,.35), inset 0 -6px 14px rgba(0,40,90,.35), inset 0 2px 0 rgba(255,255,255,.6);
    display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 22px; letter-spacing: -.02em;
    text-shadow: 0 1px 2px rgba(0,50,100,.5); }
  .orb::before { content: ""; position: absolute; top: 5px; left: 11px; right: 11px; height: 44%; border-radius: 50% 50% 45% 45%;
    background: linear-gradient(180deg, rgba(255,255,255,.95), rgba(255,255,255,.15)); }
  .orb span { position: relative; }
  .brand h1 { margin: 0; font-size: 34px; font-weight: 600; letter-spacing: -.02em; color: #fff;
    text-shadow: 0 2px 8px rgba(0,70,130,.35), 0 1px 0 rgba(0,60,110,.25); }
  .brand p { margin: 0; color: #fff; font-size: 15px; text-shadow: 0 1px 3px rgba(0,60,110,.55); }

  /* Glass panels */
  .glass { position: relative; border-radius: 26px; padding: 22px 20px; margin-bottom: 18px;
    background: linear-gradient(180deg, rgba(255,255,255,.82), var(--glass));
    backdrop-filter: blur(16px) saturate(150%); -webkit-backdrop-filter: blur(16px) saturate(150%);
    border: 1px solid rgba(255,255,255,.9);
    box-shadow: 0 14px 34px rgba(0,70,130,.18), inset 0 1px 0 #fff, inset 0 -1px 0 rgba(120,190,230,.35); }
  .glass::before { content: ""; position: absolute; inset: 1px 1px auto 1px; height: 46%; border-radius: 25px 25px 60% 60% / 25px 25px 30px 30px;
    background: linear-gradient(180deg, rgba(255,255,255,.75), rgba(255,255,255,0)); pointer-events: none; }
  .glass > * { position: relative; }
  .hero-title { font-size: 27px; line-height: 1.2; font-weight: 600; margin: 0 0 8px; letter-spacing: -.01em; }
  .lede { margin: 0; color: var(--ink-soft); }

  label { display: block; font-size: 14px; font-weight: 600; color: var(--ink-soft); margin: 14px 2px 6px; }
  input { width: 100%; font: inherit; font-size: 18px; color: var(--ink); padding: 13px 16px; border-radius: 14px;
    border: 1px solid rgba(80,160,210,.45); background: linear-gradient(180deg, #f3fbff, #fff);
    box-shadow: inset 0 2px 4px rgba(0,70,130,.12); outline: none; }
  input:focus { border-color: #39a9e8; box-shadow: inset 0 2px 4px rgba(0,70,130,.12), 0 0 0 4px rgba(90,190,255,.35); }

  /* Glossy aqua pill buttons */
  .btn { position: relative; display: block; width: 100%; margin-top: 18px; padding: 15px 20px; border-radius: 999px;
    font: inherit; font-size: 18px; font-weight: 700; color: #fff; text-align: center; text-decoration: none; cursor: pointer;
    text-shadow: 0 1px 2px rgba(0,60,0,.45);
    background: linear-gradient(180deg, var(--aqua-1) 0%, #5fd23f 48%, var(--aqua-2) 52%, #46c232 100%);
    border: 1px solid var(--aqua-edge);
    box-shadow: 0 6px 16px rgba(40,140,30,.35), inset 0 1px 0 rgba(255,255,255,.8), inset 0 -3px 8px rgba(0,80,0,.25);
    overflow: hidden; -webkit-tap-highlight-color: transparent; }
  .btn::before { content: ""; position: absolute; top: 2px; left: 12px; right: 12px; height: 46%; border-radius: 999px;
    background: linear-gradient(180deg, rgba(255,255,255,.85), rgba(255,255,255,.1)); }
  .btn span { position: relative; }
  .btn:active { transform: translateY(1px); filter: brightness(.97); }
  .btn.blue { background: linear-gradient(180deg, #9be3ff 0%, #4bbcf2 48%, #1993d8 52%, #2aa6e6 100%); border-color: #0f78b8;
    text-shadow: 0 1px 2px rgba(0,40,90,.45); box-shadow: 0 6px 16px rgba(10,110,180,.35), inset 0 1px 0 rgba(255,255,255,.8), inset 0 -3px 8px rgba(0,50,110,.25); }
  .btn.ghost { background: linear-gradient(180deg, #ffffff, #e9f6fd); color: var(--ink); text-shadow: none; border-color: rgba(80,160,210,.55);
    box-shadow: 0 4px 12px rgba(0,70,130,.12), inset 0 1px 0 #fff; }
  .btn.ghost::before { opacity: .6; }

  .err { margin: 12px 2px 0; color: #b3261e; font-weight: 600; font-size: 15px; }
  .fine { font-size: 13px; color: var(--ink-soft); margin: 12px 2px 0; text-align: center; }

  /* Result */
  .number { font-size: clamp(24px, 8.2vw, 34px); white-space: nowrap; font-weight: 700; letter-spacing: .01em; margin: 6px 0 2px; color: #0a6bb0;
    text-shadow: 0 1px 0 #fff; font-variant-numeric: tabular-nums; }
  .kicker { font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #2a8fd0; margin: 0; }

  /* Steps */
  .steps { list-style: none; padding: 0; margin: 4px 0 0; display: grid; gap: 12px; }
  .steps li { display: flex; gap: 14px; align-items: flex-start; }
  .step-orb { flex: none; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: 19px; position: relative;
    background: radial-gradient(circle at 50% 115%, #c8f7ff 0%, #79d3fb 45%, #2b9fe0 100%);
    box-shadow: 0 4px 10px rgba(0,90,160,.25), inset 0 -3px 6px rgba(0,50,110,.25); }
  .step-orb::before { content: ""; position: absolute; top: 3px; left: 7px; right: 7px; height: 42%; border-radius: 50%;
    background: linear-gradient(180deg, rgba(255,255,255,.9), rgba(255,255,255,.1)); }
  .step-orb span { position: relative; }
  .steps b { display: block; font-size: 16px; }
  .steps p { margin: 1px 0 0; font-size: 14.5px; color: var(--ink-soft); }
  code { font: 600 14px/1.4 ui-monospace, "SF Mono", Menlo, monospace; background: rgba(255,255,255,.75); border: 1px solid rgba(80,160,210,.35);
    padding: 1px 7px; border-radius: 8px; color: #0b4f7a; white-space: nowrap; }

  /* QR card: only on wide screens (the demo-table laptop) */
  .qr { display: none; text-align: center; }
  .qr svg { width: 150px; height: 150px; background: #fff; border-radius: 16px; padding: 10px; box-shadow: inset 0 1px 3px rgba(0,60,110,.15); }
  @media (min-width: 900px) {
    main { max-width: 920px; display: grid; grid-template-columns: 1fr 1fr; gap: 0 22px; align-items: start;
      grid-template-areas: "brand brand" "hero how" "hero qr" "foot foot"; padding-top: 40px; }
    .brand { grid-area: brand; }
    .hero { grid-area: hero; }
    .how { grid-area: how; }
    .qr { grid-area: qr; display: block; }
    footer { grid-area: foot; }
  }
  footer { text-align: center; font-size: 13px; color: #fff; text-shadow: 0 1px 2px rgba(0,60,40,.5); grid-column: 1 / -1; margin-top: 8px; }
`;

const BUBBLES = [
  { left: 6, size: 46, dur: 19, delay: -2 },
  { left: 18, size: 22, dur: 14, delay: -9 },
  { left: 31, size: 64, dur: 24, delay: -14 },
  { left: 47, size: 30, dur: 17, delay: -5 },
  { left: 62, size: 52, dur: 22, delay: -18 },
  { left: 74, size: 18, dur: 13, delay: -3 },
  { left: 85, size: 40, dur: 20, delay: -11 },
  { left: 93, size: 26, dur: 16, delay: -7 },
];

const HILL = `<svg class="hill" viewBox="0 0 1440 200" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b6f06a"/><stop offset=".55" stop-color="#5cc53a"/><stop offset="1" stop-color="#2f9a2a"/></linearGradient>
    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fe25a"/><stop offset="1" stop-color="#3aa82f"/></linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <path d="M0 120 C 260 40, 520 60, 760 105 S 1220 150, 1440 70 L1440 200 L0 200 Z" fill="url(#g2)" opacity=".85"/>
  <path d="M0 150 C 300 85, 640 95, 900 130 S 1300 160, 1440 120 L1440 200 L0 200 Z" fill="url(#g1)"/>
  <path d="M0 150 C 300 85, 640 95, 900 130 S 1300 160, 1440 120 L1440 138 C 1300 176, 1100 150, 900 146 S 300 104, 0 168 Z" fill="url(#shine)" opacity=".55"/>
</svg>`;

function shell(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#3fb4f0" />
        <title>${title}</title>
        <meta name="description" content="Split trip costs by text. Send Tab a receipt, everyone approves their share, settle with Apple Pay or USDC." />
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <div class="sun"></div>
        <div class="rays"></div>
        <div class="bubbles" aria-hidden="true">
          ${raw(
            BUBBLES.map(
              (b) =>
                `<div class="bubble" style="left:${b.left}%;width:${b.size}px;height:${b.size}px;animation-duration:${b.dur}s;animation-delay:${b.delay}s"></div>`,
            ).join(""),
          )}
        </div>
        ${raw(HILL)}
        <main>${body}</main>
      </body>
    </html>`;
}

const brand = html`<header class="brand">
  <div class="orb"><span>Tab</span></div>
  <div>
    <h1>Tab</h1>
    <p>Shared costs, sorted by text.</p>
  </div>
</header>`;

const howItWorks = html`<section class="glass how">
  <p class="kicker">How it works</p>
  <ul class="steps" style="margin-top:12px">
    <li><div class="step-orb"><span>💬</span></div><div><b>Start a group</b><p>Text Tab <code>new trip Asheville</code> and paste the invite link in your group chat.</p></div></li>
    <li><div class="step-orb"><span>🧾</span></div><div><b>Snap receipts</b><p>Send a photo. Tab reads it and texts everyone their share, with the receipt attached.</p></div></li>
    <li><div class="step-orb"><span>✅</span></div><div><b>Everyone approves</b><p>Nobody owes a cent they didn't OK. Text <code>WHY</code> for the full breakdown.</p></div></li>
    <li><div class="step-orb"><span>💸</span></div><div><b>Settle up</b><p>Text <code>SETTLE</code>, then pay with Apple Pay or USDC on Solana.</p></div></li>
  </ul>
</section>`;

function qrCard(qrSvg: string | undefined) {
  if (!qrSvg) return "";
  return html`<section class="glass qr">
    <p class="kicker">On a laptop?</p>
    <p class="lede" style="margin:6px 0 14px">Scan with your iPhone camera to get started.</p>
    ${raw(qrSvg)}
  </section>`;
}

export interface LandingData {
  name?: string;
  phone?: string;
  error?: string;
  qrSvg?: string;
  /** Without Photon (local dev) the form explains how to use the simulator instead. */
  messagingEnabled: boolean;
}

export function landingPage(d: LandingData) {
  return shell(
    "Tab: split costs by text",
    html`${brand}
      <section class="glass hero">
        <h2 class="hero-title">Split trip costs without the spreadsheet.</h2>
        <p class="lede">Text Tab your receipts. Everyone approves their own share. Settle up with Apple Pay or USDC.</p>
        ${d.messagingEnabled
          ? html`<form method="post" action="/start">
              <label for="name">Your first name</label>
              <input id="name" name="name" required maxlength="30" autocomplete="given-name" placeholder="Amit" value="${d.name ?? ""}" />
              <label for="phone">Your iPhone number</label>
              <input id="phone" name="phone" required type="tel" inputmode="tel" autocomplete="tel" placeholder="(919) 555-1234" value="${d.phone ?? ""}" />
              ${d.error ? html`<p class="err">${d.error}</p>` : ""}
              <button class="btn" type="submit"><span>Get my Tab number</span></button>
              <p class="fine">Tab works over iMessage. Use the number your iMessage is linked to.</p>
            </form>`
          : html`<p class="err">Texting isn't set up on this server yet. Run <code>npm run sim</code> to try Tab from a terminal.</p>`}
      </section>
      ${howItWorks} ${qrCard(d.qrSvg)}
      <footer>Made at HackNC 2026 · Photon · Gemini · Solana · Stripe</footer>`,
  );
}

export interface StartedData {
  name: string;
  line: string;
  qrSvg?: string;
}

export function formatPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function startedPage(d: StartedData) {
  const smsNew = `sms:${d.line}&body=${encodeURIComponent("new trip ")}`;
  const smsHi = `sms:${d.line}&body=${encodeURIComponent("hi")}`;
  return shell(
    "Your Tab number",
    html`${brand}
      <section class="glass hero">
        <p class="kicker">You're all set, ${d.name}</p>
        <p class="lede" style="margin-top:6px">Your Tab number is</p>
        <p class="number">${formatPhone(d.line)}</p>
        <p class="lede">Save it as a contact so it's easy to find. Then text it to start your first group.</p>
        <a class="btn" href="${smsNew}"><span>Text Tab to start a trip</span></a>
        <a class="btn blue" href="/contact.vcf?line=${encodeURIComponent(d.line)}"><span>Save Tab to Contacts</span></a>
        <a class="btn ghost" href="${smsHi}"><span>Just say hi</span></a>
        <p class="fine">Starting a trip? Finish the message, like <code>new trip Asheville</code>, and hit send.</p>
      </section>
      ${howItWorks} ${qrCard(d.qrSvg)}
      <footer>Made at HackNC 2026 · Photon · Gemini · Solana · Stripe</footer>`,
  );
}

/** A contact card for the Tab line, so people can save it in one tap. */
export function tabContactCard(line: string, siteUrl: string): string {
  return ["BEGIN:VCARD", "VERSION:3.0", "N:;Tab;;;", "FN:Tab", "ORG:Tab", `TEL;TYPE=CELL:${line}`, `URL:${siteUrl}`, "NOTE:Text receipts to split costs with your group.", "END:VCARD", ""].join("\r\n");
}
