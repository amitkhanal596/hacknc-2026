import { html, raw } from "hono/html";

/** Minimal mobile-first pages served by the API: the pay page and Connect return pages. */

const STYLE = `
  :root { --bg:#f6f5f2; --card:#fff; --ink:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --accent:#0a7c4a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --card:#1c1c1e; --ink:#f5f5f7; --muted:#a1a1a6; --line:#2c2c2e; --accent:#30d158; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  main { max-width:440px; margin:0 auto; padding:24px 16px 48px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:20px; margin-bottom:16px; }
  h1 { font-size:15px; font-weight:600; color:var(--muted); margin:0 0 4px; }
  .amount { font-size:44px; font-weight:700; letter-spacing:-0.02em; margin:0; }
  .to { color:var(--muted); margin:2px 0 0; }
  ul { list-style:none; padding:0; margin:0; }
  li { display:flex; justify-content:space-between; gap:12px; padding:10px 0; border-top:1px solid var(--line); font-size:15px; }
  li:first-child { border-top:0; }
  li span:last-child { font-variant-numeric: tabular-nums; white-space:nowrap; }
  .muted { color:var(--muted); font-size:14px; }
  button.secondary { width:100%; padding:14px; border-radius:12px; border:1px solid var(--line); background:transparent; color:var(--ink); font-size:16px; font-weight:600; }
  #status { min-height:1.4em; margin-top:12px; text-align:center; }
  .ok { color:var(--accent); font-weight:600; }
`;

function layout(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <main>${body}</main>
      </body>
    </html>`;
}

export interface PayPageData {
  token: string;
  groupName: string;
  creditorName: string;
  amount: string;
  cents: number;
  lines: { label: string; amount: string }[];
  publishableKey?: string;
}

export function payPage(d: PayPageData) {
  const applePay = d.publishableKey
    ? html`<div id="express-checkout"></div>
        <p class="muted" id="no-wallet" hidden>Apple Pay isn't available in this browser. Open this link in Safari on your iPhone, or pay with USDC below.</p>
        <script src="https://js.stripe.com/v3/"></script>
        <script>
          const token = ${raw(JSON.stringify(d.token))};
          const stripe = Stripe(${raw(JSON.stringify(d.publishableKey))});
          const elements = stripe.elements({ mode: "payment", amount: ${d.cents}, currency: "usd" });
          const ece = elements.create("expressCheckout", { buttonType: { applePay: "plain" } });
          const status = document.getElementById("status");
          ece.on("ready", ({ availablePaymentMethods }) => {
            if (!availablePaymentMethods) document.getElementById("no-wallet").hidden = false;
          });
          ece.on("confirm", async () => {
            status.textContent = "Processing…";
            const { error: submitError } = await elements.submit();
            if (submitError) { status.textContent = submitError.message; return; }
            const res = await fetch("/p/" + token + "/intent", { method: "POST" });
            const body = await res.json();
            if (!res.ok) { status.textContent = body.message; return; }
            const { error } = await stripe.confirmPayment({
              elements, clientSecret: body.clientSecret, redirect: "if_required",
              confirmParams: { return_url: location.origin + "/p/" + token + "/done" },
            });
            status.innerHTML = error ? error.message : '<span class="ok">✅ Paid! You can close this page.</span>';
          });
          ece.mount("#express-checkout");
        </script>`
    : html`<p class="muted">Apple Pay isn't set up on this server yet.</p>`;

  return layout(
    `Pay ${d.creditorName}`,
    html`<div class="card">
        <h1>${d.groupName}</h1>
        <p class="amount">${d.amount}</p>
        <p class="to">to ${d.creditorName}</p>
      </div>
      <div class="card">
        <ul>
          ${d.lines.map((l) => html`<li><span>${l.label}</span><span>${l.amount}</span></li>`)}
        </ul>
      </div>
      <div class="card">
        ${applePay}
        <div style="height:12px"></div>
        <form method="post" action="/p/${d.token}/usdc">
          <button class="secondary" type="submit">Pay with USDC from my Tab wallet</button>
        </form>
        <p id="status" class="muted"></p>
      </div>
      <p class="muted" style="text-align:center">Only approved expenses are included. Text WHY to the bot for the details.</p>`,
  );
}

export function messagePage(title: string, message: string) {
  return layout(title, html`<div class="card"><p class="amount" style="font-size:28px">${title}</p><p class="to">${message}</p></div>`);
}

export function joinPage(d: { code: string; groupName: string; members: string[]; error?: string; phone?: string; name?: string }) {
  return layout(
    `Join ${d.groupName}`,
    html`<div class="card">
        <h1>You're invited to</h1>
        <p class="amount" style="font-size:32px">${d.groupName}</p>
        <p class="to">${d.members.length ? `with ${d.members.join(", ")}` : ""}</p>
      </div>
      <div class="card">
        <form method="post" action="/j/${d.code}">
          <label class="muted" for="name">Your first name</label>
          <input id="name" name="name" required maxlength="30" autocomplete="given-name" value="${d.name ?? ""}"
            style="width:100%;padding:12px;margin:6px 0 14px;border-radius:12px;border:1px solid var(--line);font-size:17px;background:transparent;color:var(--ink)" />
          <label class="muted" for="phone">Your iPhone number (the one iMessage uses)</label>
          <input id="phone" name="phone" required type="tel" autocomplete="tel" placeholder="(919) 555-1234" value="${d.phone ?? ""}"
            style="width:100%;padding:12px;margin:6px 0 14px;border-radius:12px;border:1px solid var(--line);font-size:17px;background:transparent;color:var(--ink)" />
          ${d.error ? html`<p style="color:#d70015;margin:0 0 12px">${d.error}</p>` : ""}
          <button class="secondary" type="submit" style="background:var(--ink);color:var(--bg);border:0">Join &amp; get a text from Tab</button>
        </form>
      </div>
      <p class="muted" style="text-align:center">Tab texts you to track shared costs. You only owe what you approve.</p>`,
  );
}

export function joinedPage(d: { groupName: string; code: string; line?: string; joinText?: string }) {
  if (!d.line || !d.joinText) {
    return layout(
      "You're in",
      html`<div class="card">
        <p class="amount" style="font-size:30px">✅ You're in ${d.groupName}</p>
        <p class="to">Tab will text you. Check Messages.</p>
      </div>`,
    );
  }
  const sms = `sms:${d.line}&body=${encodeURIComponent(d.joinText).replace(/'/g, "%27")}`;
  return layout(
    "One last step",
    html`<div class="card">
        <h1>One last step</h1>
        <p class="amount" style="font-size:28px">Text Tab to join ${d.groupName}</p>
        <p class="to">Tap the button, then hit send. Messages opens with everything filled in.</p>
      </div>
      <div class="card">
        <a href="${sms}" style="text-decoration:none">
          <button class="secondary" type="button" style="background:var(--accent);color:#fff;border:0;font-size:18px;padding:16px">Text Tab to join</button>
        </a>
        <p class="muted" style="margin-bottom:0">Your Tab number is <b>${d.line}</b>. Save it as a contact named "Tab".<br />
        Or text it yourself: <b>${d.joinText}</b></p>
      </div>`,
  );
}
