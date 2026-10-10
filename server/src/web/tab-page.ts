import { html, raw } from "hono/html";
import { netPhrase, personPhrase, type TabSummary } from "../bot/summary";
import { shortDate } from "../copy";
import { formatCents as $ } from "../ledger/money";
import { aeroShell } from "./landing";

/**
 * "Your Tab": what opens when someone taps the card Tab texted them. Running
 * total, how each person nets out, every expense with their share, and buttons
 * to pay or settle. The Open Graph tags make iMessage show the rich card.
 */

const EXTRA = `
  .total { font-size: clamp(40px, 13vw, 58px); font-weight: 800; letter-spacing: -.02em; margin: 2px 0 4px; line-height: 1.05; }
  .total.owed { color: #2b8a1d; } .total.owe { color: #0a6bb0; } .total.even { color: #0b3550; }
  .sub { color: var(--ink-soft); font-size: 15px; margin: 0; }
  .rows { list-style: none; margin: 10px 0 0; padding: 0; }
  .rows li { display: flex; gap: 12px; align-items: center; padding: 11px 0; border-top: 1px solid rgba(80,160,210,.22); }
  .rows li:first-child { border-top: 0; }
  .who { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 15px;
    background: radial-gradient(circle at 50% 120%, #7ff0ff 0%, #6fd0ff 35%, #1590d6 75%, #0b5f99 100%); box-shadow: 0 3px 8px rgba(0,80,150,.3); }
  .grow { flex: 1; min-width: 0; }
  .grow b { display: block; font-size: 15.5px; }
  .grow > span { display: block; font-size: 13.5px; color: var(--ink-soft); }
  .amt { font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .amt.pos { color: #2b8a1d; } .amt.neg { color: #0a6bb0; } .amt.dim { color: #8aa5b8; font-weight: 600; }
  .tag { display: inline-block; font-size: 11.5px; font-weight: 700; padding: 1px 8px; border-radius: 999px; margin-left: 6px; vertical-align: 1px;
    background: rgba(255,255,255,.85); border: 1px solid rgba(80,160,210,.4); color: #2a6f9c; }
  .tag.hold { background: #fff6dc; border-color: #f1c75b; color: #8a5a00; }
  .tag.today { background: #e8fbe0; border-color: #8fd36f; color: #2b6f1d; }
  .expenses { text-align: left; }
  footer { color: #2d5a75; text-shadow: 0 1px 0 rgba(255,255,255,.7); }
  @media (min-width: 900px) { .expenses { grid-area: qr; } }
`;

export interface TabPageData {
  summary: TabSummary;
  token: string;
  publicBaseUrl: string;
  /** Pay links per person you owe (Apple Pay page), if Stripe is on. */
  payLinks: { name: string; cents: number; url: string }[];
  /** The person's Tab number, for "text Tab" buttons. */
  line?: string;
}

const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

export function tabPage(d: TabPageData) {
  const s = d.summary;
  const cardUrl = `${d.publicBaseUrl}/t/${d.token}/card.png`;
  const title = `${s.user.displayName ?? "Your"}'s tab · ${s.group.name}`;
  const description = `${netPhrase(s.net).replace(/^you/, "You")} · ${s.expenses.filter((e) => e.yourShare !== null).length} expenses`;
  const head = html`<meta property="og:type" content="website" />
    <meta property="og:site_name" content="Tab" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${cardUrl}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:url" content="${d.publicBaseUrl}/t/${d.token}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="robots" content="noindex" />
    <style>
      ${raw(EXTRA)}
    </style>`;
  const cls = s.net > 0 ? "owed" : s.net < 0 ? "owe" : "even";
  const sms = (body: string) => (d.line ? `sms:${d.line}&body=${encodeURIComponent(body)}` : undefined);

  return aeroShell(
    title,
    html`<header class="brand">
        <div class="orb"><span>Tab</span></div>
        <div><h1>Your tab</h1><p>${s.group.name}</p></div>
      </header>

      <section class="glass hero">
        <p class="kicker">Running total</p>
        <p class="total ${cls}">${s.net === 0 ? "All even" : $(Math.abs(s.net))}</p>
        <p class="lede">${s.net > 0 ? "You're owed this overall." : s.net < 0 ? "You owe this overall." : "Nobody owes anybody right now."}</p>
        <p class="sub" style="margin-top:8px">You've paid ${$(s.paidCents)} · your share of everything is ${$(s.yourShareCents)}</p>
        ${d.payLinks.map((p) => html`<a class="btn blue" href="${p.url}"><span>Apple Pay ${p.name} ${$(p.cents)}</span></a>`)}
        ${sms("SETTLE") ? html`<a class="btn" href="${sms("SETTLE")}"><span>Settle up the trip</span></a>` : ""}
        ${s.net < 0 && sms("PAY") ? html`<a class="btn ghost" href="${sms("PAY")}"><span>Pay in USDC instead</span></a>` : ""}
      </section>

      <section class="glass how">
        <p class="kicker">Who owes who</p>
        ${s.people.length
          ? html`<ul class="rows">
              ${s.people.map(
                (p) => html`<li>
                  <div class="who">${initial(p.name)}</div>
                  <div class="grow"><b>${p.name}</b><span>${personPhrase(p)}</span></div>
                  <div class="amt ${p.net > 0 ? "pos" : p.net < 0 ? "neg" : "dim"}">${p.net === 0 ? "even" : (p.net > 0 ? "+" : "−") + $(Math.abs(p.net))}</div>
                </li>`,
              )}
            </ul>
            <p class="fine" style="text-align:left">When two people owe each other, only the difference is paid.</p>`
          : html`<p class="lede" style="margin-top:8px">No shared expenses yet.</p>`}
      </section>

      <section class="glass expenses">
        <p class="kicker">Every expense</p>
        ${s.expenses.length
          ? html`<ul class="rows">
              ${s.expenses.map(
                (e) => html`<li>
                  <div class="grow">
                    <b>${e.description} ${e.today ? html`<span class="tag today">today</span>` : ""}${e.status === "flagged" ? html`<span class="tag hold">on hold</span>` : ""}${e.hasReceipt ? html`<span class="tag">🧾</span>` : ""}</b>
                    <span>${e.payerName} paid ${$(e.totalCents)} · ${shortDate(e.createdAt)}</span>
                  </div>
                  <div class="amt ${e.yourShare === null ? "dim" : e.youPaid ? "pos" : "neg"}">${e.yourShare === null ? "not in it" : `your part ${$(e.yourShare)}`}</div>
                </li>`,
              )}
            </ul>`
          : html`<p class="lede">Nothing logged yet. Text Tab a receipt to start.</p>`}
      </section>
      <footer>Something off? Text Tab NOPE and what's wrong.</footer>`,
    { head, description },
  );
}
