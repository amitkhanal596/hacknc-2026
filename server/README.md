# Tab server

The bot, ledger, payments, and the HTTP API behind the iMessage extension and the Apple Pay pay page. Design docs: [../ARCHITECTURE.md](../ARCHITECTURE.md). Status: [../PROGRESS.md](../PROGRESS.md). **Keys, live tests, and testing on your iPhone: [../TESTING.md](../TESTING.md).**

## Quick start

```bash
cd server
npm install
cp .env.example .env   # every key is optional; missing ones fall back to local stubs
npm test               # 44 tests: ledger, the full DM scenario, API, jobs, Stripe flow, join page
npm run sim            # text the bot as different people from your terminal
```

Needs Node 22+. No Bun or global installs required.

### The simulator

`npm run sim` runs the real bot, ledger, jobs, and HTTP API with an in-memory database. You type DMs as whoever you want:

```
[amit] > new trip Asheville
📱 Tab → amit: Asheville Trip created! Paste this in your group chat so people can join:
📱 Tab → amit: Join our Asheville Trip tab 👉 http://localhost:3000/j/ASHEV09
[amit] > /as jake
[jake] > JOIN ASHEV09
[jake] > /as amit
[amit] > /receipt 80 Shell | gas, everyone
```

| Command | What it does |
|---|---|
| `/as <name>` | Switch who's texting. New names get a fake phone number. |
| `/receipt <amount> [merchant] [\| caption]` | Send a fake receipt photo (no Gemini needed). |
| `/photo <file> [\| caption]` | Send a real image (Gemini reads it). |
| `/advance <minutes>` | Move the clock forward, then run jobs (payment reminders after SETTLE). |
| `/jobs` | Run jobs now. |
| `/who`, `/quit` | |

Add `-- --persist` to keep data in `./data/sim.db` between runs.

### Running for real

For iPhone testing and demos use `npm run phone` (tunnel + Stripe Apple Pay domain + webhooks + server). Its public URL's home page is the signup site where organizers get their Tab number. `npm run preview:site` previews that page with fake data. See [TESTING.md](../TESTING.md).


```bash
npm run dev            # Spectrum DMs + HTTP API + jobs (restarts on file changes)
npm start              # same, without watch
```

| Feature | Turn it on with | Without it |
|---|---|---|
| iMessage DMs | `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`. On shared-line plans each phone must be registered: the `/j/:code` join page does it, or `npm run photon:register -- +1… Name`. | Outbound DMs are printed to the console. Use `npm run sim` to talk to the bot. |
| Gemini | `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) | Regex extractor: handles "paid $80 for gas, split with jake and sam". Can't read real photos. |
| Solana devnet | `npm run setup:devnet` (writes `TREASURY_SECRET_KEY` + `USDC_MINT` into `.env`) | Simulated transfers, clearly labeled "USDC, simulated". |
| Apple Pay | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Settle-up texts only offer USDC. |

**Stripe setup (test mode):** use a Stripe [sandbox](https://docs.stripe.com/sandboxes) and a restricted key if you can. Enable Connect. Register the deployed domain under Settings → Payment method domains so the Apple Pay button shows in Safari. For local webhooks: `stripe listen --events payment_intent.succeeded,payment_intent.payment_failed,account.updated,transfer.created --forward-to localhost:3000/stripe/webhook` (`npm run phone` does this for you), and put the printed `whsec_…` in `STRIPE_WEBHOOK_SECRET`.

## Layout

```
src/
  index.ts / sim.ts       entry points (real server / terminal simulator)
  config.ts context.ts    env parsing; the Ctx object passed everywhere (db, messenger, extractor, chain, stripe, clock)
  messaging/              Messenger interface + Spectrum adapter + in-memory adapter
  bot/                    DM handler, command parser, WHY explanations, approval/settle messages
  ai/                     Extractor interface + Gemini + regex fallback
  ledger/                 pure money logic: splits, validation flags, share state machine, pairwise debts
  store/                  database reads/writes (users, groups, expenses+shares+audit, payments, prompts)
  payments/               pay router (caps, Solana, Apple Pay, webhooks), Solana chain + wallets, Stripe rail, signed tokens
  api/                    Hono app: extension API, pay page, Stripe webhook, Connect return
  jobs/                   payment reminders (after SETTLE) with backoff, held-payment sweep, stale-payment expiry
  web/                    HTML: home/signup page (landing.ts), tab page + iMessage preview card (tab-page.ts, card.ts), join, pay and status pages
  copy.ts notify.ts       all user-facing message text; DM send + log
drizzle/                  SQL migrations (run automatically on boot)
scripts/                  setup-devnet, phone (iPhone launcher), photon-register, check-photon, check-stripe
test/                     vitest suites
```

Changing the schema: edit `src/db/schema.ts`, then `npx drizzle-kit generate --name <change>`.

## Bot commands (1:1 DMs)

`NEW <name>` (replies with an invite link to `/j/<code>`) · `SUMMARY` / "what are my expenses" / "my tab" (text summary + rich link card to `/t/<token>`) · `JOIN <code> [- I'm Name]` · `USE <group>` · `GROUPS` · `NAME <name>` · `BALANCE` · `SETTLE` · `PAY [name]` · `WHY [name]` · `NOPE <what's off>` (flag your share) · after a NOPE the payer can reply with a new amount in plain words ("$30 is fine", "make it 40", `FIX 40`), `OK` the amount suggested ("nope, should be $30"), or `REMOVE` · the payer can fix who an expense was for: "that was just for Jake", "only Jake and me", "split it with everyone" · `PAYOUTS` · `HELP`

Anything else is treated as a possible expense: text ("paid $80 for gas, split with jake and sam"), a receipt photo, or a screenshot of a chat message.
