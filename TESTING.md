# Tab: Setup, Testing, and the iPhone Demo

Everything about getting Tab running for real: which keys are set up, what's been tested, the few steps only you can do, how to test from your iPhone, and how to run the in-person demo.

**Short answer on the demo: yes, you can demo it live on phones.** People text a real iMessage number, receipts are read from real photos, and debts are settled with Apple Pay (Stripe test mode, so no card is charged) or USDC. The one thing that isn't built yet is the native iMessage extension. The demo runs on plain texts plus the web pay page, which already works on iPhone.

---

## 1. Where setup stands

All keys live in `server/.env`. Git ignores that file, so it never gets pushed. `server/.env.example` is the blank template.

| Key | Status | How it was checked |
|---|---|---|
| `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` | ✅ set, working | Connected to Spectrum cloud in ~0.5s. Read your project info: **Pro** plan, **shared** iMessage line, 0 registered users. |
| `GEMINI_API_KEY` (`gemini-2.5-flash`) | ✅ set, working | Read a receipt **photo** (Shell, $80.00, line items, date) and parsed texts like "airbnb was 640, everyone but sam" correctly. |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | ✅ set, test mode | Created a real PaymentIntent through our code, paid it with Stripe's test Visa, webhook marked it paid. |
| `STRIPE_WEBHOOK_SECRET` | ✅ generated with the Stripe CLI | Webhook arrived through `stripe listen` and passed signature verification. |
| `WALLET_ENC_KEY`, `APP_SECRET` | ✅ generated (random) | Used to encrypt wallet keys and sign pay links / login tokens. |
| `TREASURY_SECRET_KEY` | ✅ generated | Solana devnet wallet `5m7LeDG5jYUSnuobuTu1VimKWsZ3Uy7fdC4rYBLWwdQQ` |
| `USDC_MINT` | ⏳ **waiting on you** (step 2a) | The wallet needs a little free devnet SOL first. Until then, USDC payments run in labeled "simulated" mode. |
| `PUBLIC_BASE_URL` | set automatically by `npm run phone` | Each run gets a fresh `https://….trycloudflare.com` URL. |

Installed on your Mac: **Stripe CLI** 1.53.1, **cloudflared** (the HTTPS tunnel), and **Rust + devnet-pow** (tried for free devnet SOL; see 2a).

### What's been tested

| Test | Result |
|---|---|
| `npm test`: ledger math, the full Asheville scenario over DMs, extension API, jobs, Apple Pay flow (fake Stripe), join page, Photon registration request | ✅ **44 / 44** |
| Simulator with **real Gemini**: receipt photo → expense, "dinner was 96, split with jake" → 2-way split, "pay me $20" → asks why, approvals, WHY, settle-up with Apple Pay links | ✅ |
| `npm run check:stripe`: real PaymentIntent → test card → webhook → payment recorded | ✅ |
| `npm run phone`: public HTTPS tunnel, Stripe registered the domain with **Apple Pay: active**, server reachable from the internet | ✅ |
| Photon: credentials connect and the bot listens | ✅ |
| Photon: a real text round trip from your iPhone | ⏳ needs your phone (step 2c) |
| Apple Pay sheet on a real iPhone | ⏳ needs your phone (section 3) |
| Connect payouts (person owed connects a bank) | ⏳ needs a Stripe Dashboard step (2b) |
| Real Solana devnet transfer | ⏳ needs devnet SOL (2a) |

---

## 2. The three things only you can do (~5 minutes total)

### 2a. Get free devnet SOL (unlocks real USDC payments)
The automatic faucet is rate-limited for your network, and the web faucet asks AI agents not to use it, so this one is yours:

1. Open **https://faucet.solana.com**. Leave the network on **devnet**.
2. Paste this address: `5m7LeDG5jYUSnuobuTu1VimKWsZ3Uy7fdC4rYBLWwdQQ`
3. Request **1 SOL** (0.5 is plenty). It's test money with no value.
4. Back in the terminal:
   ```bash
   cd server
   npm run setup:devnet
   ```
   It creates the tUSDC token and writes `USDC_MINT` into `.env` for you. Restart the server, and `PAY` sends real devnet transactions with Solana Explorer links.

Until you do this, everything still works. USDC payments are just labeled "USDC, simulated".

### 2b. Turn on Connect payouts in Stripe (lets the person owed get Apple Pay money)
Our design has Stripe hold Apple Pay money until the person owed connects their bank, then pass it along. Stripe requires the platform to accept responsibility for that first:

1. Open **https://dashboard.stripe.com/settings/connect/platform-profile** (make sure you're in your sandbox).
2. Complete the **loss-liability acknowledgement** (and any questions it asks).
3. Check it: in one terminal run `stripe listen --events payment_intent.succeeded,payment_intent.payment_failed,account.updated,transfer.created --forward-to localhost:3997/stripe/webhook`. In another, run `npm run check:stripe`. The last lines should now show a Connect account and an onboarding link instead of the ⚠️ warning.

Until you do this, Apple Pay payments still go through and are marked paid. They just stay held, and the person owed sees "text PAYOUTS", which replies that payouts aren't switched on yet.

### 2c. Register your phone with Photon
Your Photon plan uses a **shared pool of iMessage lines**:
- Only phone numbers registered to your project can text the bot.
- Each person may be given a **different** number to text.

The app handles this for your friends: the invite link registers them. For yourself, as the organizer:

```bash
cd server
npm run photon:register -- +1YOURNUMBER Amit
```
It prints **the number to text**. Save it in Contacts as "Tab".

To check the round trip right away (sends you one hello, then prints what you text back for 2 minutes):
```bash
npm run check:photon -- +1YOURNUMBER
```
If texts don't arrive, Apple may be using a different handle for your iMessage (an email instead of your number). Open **https://debug.photon.codes** on your iPhone, which tells you the exact handle, and register that instead.

---

## 3. Testing from your iPhone

### Start everything with one command
```bash
cd server
npm run phone
```
This:
1. opens a public HTTPS tunnel to your laptop (cloudflared),
2. registers that domain with Stripe so the **Apple Pay button can appear**,
3. forwards Stripe webhooks to the server,
4. starts the bot with that public URL.

Keep it running; Ctrl+C stops everything. It prints something like:
```
Ready for your iPhone
  Public URL:   https://weekly-appeared-diet-musicians.trycloudflare.com
  Health check: https://…/health  (open it in Safari on your phone)
```
Your phone doesn't need to be on the same Wi-Fi. The tunnel is public.

### Walkthrough (one phone works; two is better)

| # | On your iPhone | What should happen |
|---|---|---|
| 1 | Open the health URL in Safari | `{"ok":true}`, so the phone can reach your laptop |
| 2 | Text Tab: `new trip Test` | "Test Trip created!" plus an invite link (`…/j/TESTT12`) and "What should I call you?" Reply with your name. |
| 3 | Open the invite link on a **second phone** (or send it to a friend) | A join page. Enter a name + iPhone number, tap **Join**. That phone gets a text from Tab, and you get "👋 Jake joined". |
| 4 | Send Tab a **photo of any receipt** with a caption like `gas, everyone` | "Logged to Test Trip: Gas $X · split 2 ways · 🧾 receipt matched". Your friend is asked to approve. |
| 5 | Text `pay me $20` | "What was the $20.00 for?" Reply `snacks` and it gets logged with ⚠️ no receipt. |
| 6 | On the friend's phone: `YES ALL` | Approved. You get "✅ Everyone approved…" |
| 7 | Friend: `WHY` | Breakdown: which expense, the receipt, the math, when they approved |
| 8 | Anyone: `SETTLE` | Each person who owes money gets "Reply PAY… or pay with Apple Pay: https://…" |
| 9 | Friend taps the **Apple Pay link** | Safari shows the amount, the line items, and an **Apple Pay** button. Pay with Face ID. |
| 10 | | Both phones get "✅ Paid" / "💸 … paid you $X (Apple Pay)". |
| 11 | Or friend texts `PAY` | USDC payment ("simulated" until step 2a; afterwards with a Solana Explorer link) |

**About Apple Pay in test mode:** you need a real card in Apple Wallet on the iPhone and must use **Safari**. Stripe test mode returns a test token, so **nothing is charged**. If the button doesn't show:
- Make sure you're in Safari (not an in-app browser) and have a card in Wallet.
- Check the `npm run phone` output for "Registered … with Stripe (Apple Pay: active)".
- The page still offers "Pay with USDC" as a fallback.

### Testing without a phone
`npm run sim` runs the whole bot in your terminal. Use `/as <name>` to switch people, `/photo <file>` to send a real image to Gemini, and `/receipt 80 Shell` to send a fake one. See [server/README.md](./server/README.md).

---

## 4. The in-person demo

### What the judges see (about 3 minutes)
Three phones (you plus two teammates), with the laptop showing the `npm run phone` logs or the simulator as a backup:

1. **Setup (before you present):** run `npm run phone`. Text `new trip Asheville` and paste the invite link into your real group chat. Teammates join through the link, so their phones are registered and Tab has texted them.
2. **Live:** a teammate photographs a real receipt and texts it with "gas, everyone". Every phone buzzes with its own approval request.
3. Someone texts **"pay me $20"**: Tab asks what it was for. This is the anti-abuse moment.
4. One teammate **disputes** an expense. The payer gets FIX / WITHDRAW options and sends a receipt photo. Everyone re-approves.
5. Someone texts **WHY**: an itemized, sourced answer.
6. **SETTLE**: one person pays with **Apple Pay** (Face ID, on stage), another texts **PAY** (USDC on Solana devnet, Explorer link on the laptop).

### Before demo day checklist
- [ ] Steps 2a, 2b, 2c done
- [ ] Every demo phone has joined once through the invite link (registers it with Photon)
- [ ] A real card in Apple Wallet on the phone that will use Apple Pay
- [ ] Rehearse with `DEMO_MODE=true` (default): reminders and auto-approve happen in minutes instead of hours
- [ ] Start from a clean database: `rm server/data/tab.db` (or set `DATABASE_PATH` to a new file)

### Risks and backups
| Risk | What to do |
|---|---|
| Venue Wi-Fi is bad | Run the laptop on a phone hotspot. Everything goes through the internet anyway, nothing needs local network access. |
| Quick-tunnel URL changes each time `npm run phone` restarts | Start it once before presenting and don't restart (old invite and pay links stop working on restart). For a sturdier demo, deploy to Railway/Fly with a fixed domain and register it in Stripe → Settings → Payment method domains. |
| A phone isn't registered with Photon | Have them open the invite link (or run `npm run photon:register -- +1…`). Shared-line plans cap how many users a project can have (a full project returns "project is full"), and third-party write-ups mention daily new-conversation limits, so register the demo phones the day before. |
| Someone has an Android phone | iMessage only, so use iPhones for the demo. |
| Gemini is slow or down | The bot falls back to its text parser automatically. Receipts photos need Gemini, so have a text expense ready ("paid $80 for gas, everyone"). |
| Something breaks live | Switch the laptop to `npm run sim -- --persist` and run the same script from the terminal. |

### What isn't demo-able yet
- **The native iMessage extension** (Phase 6 in PROGRESS.md). The server API it needs is done. The demo uses texts + the pay page instead.
- **Link-preview images** for pay links. iMessage still shows the link.
- **Real Solana / Connect payouts** until steps 2a / 2b are done.

---

## 5. Command reference (run inside `server/`)

| Command | What it does |
|---|---|
| `npm test` | All 44 tests (no network) |
| `npm run sim` | Text the bot from your terminal as different people |
| `npm run phone` | Tunnel + Stripe domain + webhooks + server, for iPhone testing and demos |
| `npm run dev` | Server only (Photon + API + jobs), restarts on file changes |
| `npm run photon:register -- +1… Name` | Register a phone with Photon and print the number it should text |
| `npm run check:photon -- +1…` | Register, text yourself a hello, print replies for 2 minutes |
| `npm run check:stripe` | Live Stripe test: PaymentIntent → test card → webhook (needs `stripe listen` on port 3997) |
| `npm run setup:devnet` | Create the Solana devnet treasury + tUSDC token and write them to `.env` |

### Security reminders
- Keys go in `server/.env` only. Never put them in `.env.example`, since that file is committed.
- Everything is test mode / devnet. Before using real money you'd need live Stripe keys, an embedded-wallet provider instead of server-held keys, and a fixed domain.
- Photon project credentials grant full management of the project. If they ever leak, rotate them in the Photon dashboard.
