# Tab server

The bot, ledger, payments, and the HTTP API behind the iMessage extension and the Apple Pay pay page. Design docs: [../ARCHITECTURE.md](../ARCHITECTURE.md). Status: [../PROGRESS.md](../PROGRESS.md).

## Quick start

```bash
cd server
npm install
cp .env.example .env   # every key is optional; missing ones fall back to local stubs
npm test               # 40 tests: ledger, the full DM scenario, API, jobs, Stripe flow
npm run sim            # text the bot as different people from your terminal
```

Needs Node 22+. No Bun or global installs required.

### The simulator

`npm run sim` runs the real bot, ledger, jobs, and HTTP API with an in-memory database. You type DMs as whoever you want:

```
[amit] > new trip Asheville
📱 Tab → amit: Asheville Trip created! Paste this in your group chat so people can join:
📱 Tab → amit: Join our Asheville Trip tab 👉 sms:+15555550100&body=JOIN%20ASHEV09
[amit] > /as jake
[jake] > JOIN ASHEV09
[jake] > /as amit
[amit] > /receipt 80 Shell | gas, everyone
```

| Command | What it does |
|---|---|
| `/as <name>` | Switch who's texting. New names get a fake phone number. |
| `/receipt <amount> [merchant] [\| caption]` | Send a fake receipt photo (no Gemini needed). |
| `/advance <minutes>` | Move the clock forward, then run jobs (auto-approve, reminders). |
| `/jobs` | Run jobs now. |
| `/who`, `/quit` | |

Add `-- --persist` to keep data in `./data/sim.db` between runs.

### Running for real

```bash
npm run dev            # Spectrum DMs + HTTP API + jobs (restarts on file changes)
npm start              # same, without watch
```

| Feature | Turn it on with | Without it |
|---|---|---|
| iMessage DMs | `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | Outbound DMs are printed to the console. Use `npm run sim` to talk to the bot. |
| Gemini | `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) | Regex extractor: handles "paid $80 for gas, split with jake and sam". Can't read real photos. |
| Solana devnet | `npm run setup:devnet`, then paste `TREASURY_SECRET_KEY` + `USDC_MINT` | Simulated transfers, clearly labeled "USDC, simulated". |
| Apple Pay | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Settle-up texts only offer USDC. |

**Stripe setup (test mode):** use a Stripe [sandbox](https://docs.stripe.com/sandboxes) and a restricted key if you can. Enable Connect. Register the deployed domain under Settings → Payment method domains so the Apple Pay button shows in Safari. For local webhooks: `stripe listen --forward-to localhost:3000/stripe/webhook`, and put the printed `whsec_…` in `STRIPE_WEBHOOK_SECRET`.

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
  jobs/                   auto-approve, reminders with backoff, held-payment sweep, stale-payment expiry
  web/                    HTML for the pay page and status pages
  copy.ts notify.ts       all user-facing message text; DM send + log
drizzle/                  SQL migrations (run automatically on boot)
scripts/setup-devnet.ts   treasury + tUSDC mint on Solana devnet
test/                     vitest suites
```

Changing the schema: edit `src/db/schema.ts`, then `npx drizzle-kit generate --name <change>`.

## Bot commands (1:1 DMs)

`NEW <name>` · `JOIN <code> [- I'm Name]` · `USE <group>` · `GROUPS` · `NAME <name>` · `BALANCE` · `SETTLE` · `PAY [name]` · `WHY [name]` · `YES` / `YES ALL` / `YES 1 3` · `DISPUTE [n] <reason>` · `FIX $amount` / `WITHDRAW` (payer, after a dispute) · `PAYOUTS` · `HELP`

Anything else is treated as a possible expense: text ("paid $80 for gas, split with jake and sam"), a receipt photo, or a screenshot of a chat message.
