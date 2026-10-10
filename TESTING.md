# Tab: Setup, Testing, and the iPhone Demo

Everything about getting Tab running for real: which keys are set up, what's been tested, the few steps only you can do, how to test from your iPhone, and how to run the in-person demo.

**Short answer on the demo: yes, you can demo it live on phones.** People text a real iMessage number, receipts are read from real photos, and debts are settled with Apple Pay (Stripe test mode, so no card is charged) or USDC. The one thing that isn't built yet is the native iMessage extension. The demo runs on plain texts plus the web pay page, which already works on iPhone.

---

## 1. Where setup stands

All keys live in `server/.env`. Git ignores that file, so it never gets pushed. `server/.env.example` is the blank template.

| Key | Status | How it was checked |
|---|---|---|
| `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` | ✅ set, working | Connected to Spectrum cloud in ~0.5s. Read your project info: **Pro** plan, **shared** iMessage line, 0 registered users. |
| `GEMINI_API_KEY` + `GEMINI_MODEL` chain | ✅ set, working | Read your real Cook-Out receipt and test receipts correctly. Rejects random pictures. **Free tier: 20 requests/day per model**, so the bot rotates through 4 models (see §6). |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | ✅ set, test mode | Created a real PaymentIntent through our code, paid it with Stripe's test Visa, webhook marked it paid. |
| `STRIPE_WEBHOOK_SECRET` | ✅ generated with the Stripe CLI | Webhook arrived through `stripe listen` and passed signature verification. |
| `WALLET_ENC_KEY`, `APP_SECRET` | ✅ generated (random) | Used to encrypt wallet keys and sign pay links / login tokens. |
| `TREASURY_SECRET_KEY` | ✅ funded (~1 SOL) | Solana devnet wallet `5m7LeDG5jYUSnuobuTu1VimKWsZ3Uy7fdC4rYBLWwdQQ` |
| `USDC_MINT` | ✅ `5usRFH3rUA2zew58aS76N7163wsthURfa4RMVA7jeFoW` | `npm run check:solana`: real on-chain $12.34 transfer in ~2.7s, balances verified. |
| `PUBLIC_BASE_URL` | set automatically by `npm run phone` | Each run gets a fresh `https://….trycloudflare.com` URL. |

Installed on your Mac: **Stripe CLI** 1.53.1, **cloudflared** (the HTTPS tunnel), and **Rust + devnet-pow** (tried for free devnet SOL; see 2a).

### What's been tested

| Test | Result |
|---|---|
| `npm test`: ledger math, the full Asheville scenario over DMs, extension API, jobs, Apple Pay flow (fake Stripe), join page, Photon registration, receipt-photo forwarding, image rejection, Gemini model fallback, home page, dispute fixes, running tab, tab summary + card, paying for someone, fixing who, multiple trips, Gemini savings | ✅ **109 / 109** |
| Simulator with **real Gemini**: receipt photo → expense, "dinner was 96, split with jake" → 2-way split, "pay me $20" → asks why, approvals, WHY, settle-up with Apple Pay links | ✅ |
| `npm run check:stripe`: real PaymentIntent → test card → webhook → payment recorded | ✅ |
| `npm run phone`: public HTTPS tunnel, Stripe registered the domain with **Apple Pay: active**, server reachable from the internet | ✅ |
| Photon: credentials connect and the bot listens | ✅ |
| Photon: registered +1 919-813-8735 → assigned line **+1 415-605-5838** | ✅ |
| Photon: you texting the bot | ✅ "hi" from +1 919-813-8735 arrived |
| Photon: bot texting you (after you texted it once) | ✅ text **and photo** delivered |
| Photon: bot texting someone who never texted it | ❌ refused ("Target not allowed"), so the invite page has people text first |
| Your own end-to-end run: Cook-Out receipt photo → expense, approvals, real devnet `PAY` | ✅ |
| Apple Pay sheet on a real iPhone | ⏳ needs your phone (section 3) |
| Connect payouts: payout account + onboarding link created live | ✅ (finishing onboarding in the browser is the last manual step) |
| Real Solana devnet transfer (`npm run check:solana`) | ✅ |

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

The app handles this for everyone:
- **Organizers** open the **home page** (the public URL from `npm run phone`, e.g. `https://….trycloudflare.com/`). They enter their name and iPhone number and get their Tab number, with buttons to text it and save it as a contact. On a laptop, the page also shows a QR code to scan.
- **Friends** use the invite link from `new trip …`, which registers them the same way.

Command-line alternative: `npm run photon:register -- +1YOURNUMBER Amit` prints the number to text.

To check the round trip right away (sends you one hello, then prints what you text back for 2 minutes):
```bash
npm run check:photon -- +1YOURNUMBER
```
**Troubleshooting "Target not allowed for this project"** (what happened on the first live test, even though the number is registered):
1. **Text the bot first.** From your iPhone, send any message to your assigned line (for +1 919-813-8735 that's **+1 415-605-5838**). Then run `CHECK_MINUTES=10 npm run check:photon`. If your text shows up there, inbound works and the bot can reply in that conversation.
2. **Check which address your iPhone's iMessage really uses.** Open **https://debug.photon.codes** on the iPhone and it replies with the exact handle. If it's an email, either register that email in the Photon dashboard (Users), or on the iPhone go to Settings → Messages → Send & Receive and set "Start new conversations from" to your phone number.
3. If both look right and sending still fails, it's on Photon's side (shared-line routing). Ask the Photon sponsors at HackNC, and mention the project is on the Pro plan with a shared line.

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
| 1b | Open the **home page** (the public URL itself) in Safari. Enter your name and number, then tap **Text Tab to start a trip**. | Your Tab number, plus "Text Tab" / "Save to Contacts" buttons |
| 2 | Text Tab: `new trip Test` | "Test Trip created!" plus an invite link (`…/j/TESTT12`) and "What should I call you?" Reply with your name. |
| 3 | Open the invite link on a **second phone** (or send it to a friend) | A join page. Enter a name + iPhone number, tap **Join**. That phone gets a text from Tab, and you get "👋 Jake joined". |
| 4 | Send Tab a **photo of any receipt** with a caption like `gas, everyone` | "Logged to Test Trip: Gas $X · split 2 ways · 🧾 receipt matched". Your friend is asked to approve. |
| 5 | Text `pay me $20` | "What was the $20.00 for?" Reply `snacks` and it gets logged with ⚠️ no receipt. |
| 6 | Check the friend's phone | The receipt photo, then "Your share: $X · Running total: you owe $X". Nothing to approve. It already counts. |
| 7 | Friend: `nope, I didn't eat` → you reply `make it 30` | Their share goes on hold, then the updated amount counts. Friend: `WHY` shows the breakdown. |
| 7b | Anyone: `what are my expenses` | A short summary, then a **card** in the chat with your running total. Tap it to see "Your Tab" with every expense. (The card image loads automatically if Tab is saved as a contact; otherwise tap "Tap to load preview".) |
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

1. **Setup (before you present):** run `npm run phone` and open the home page on the laptop. Its QR code lets anyone at the table scan and get their own Tab number. Text `new trip Asheville` and paste the invite link into your real group chat. Teammates join through the link, so their phones are registered and Tab has texted them.
2. **Live:** a teammate photographs a real receipt and texts it with "gas, everyone". Every phone buzzes with its own approval request.
3. Someone texts **"pay me $20"**: Tab asks what it was for. This is the anti-abuse moment.
4. One teammate replies **"nope, I didn't ride"**. Their share goes on hold, the payer replies "make it $60" (or sends the receipt), and everyone gets a fresh heads-up with their updated running total.
5. Someone texts **WHY**: an itemized, sourced answer.
6. **SETTLE**: one person pays with **Apple Pay** (Face ID, on stage), another texts **PAY** (USDC on Solana devnet, Explorer link on the laptop).

### Before demo day checklist
- [ ] Steps 2a, 2b, 2c done
- [ ] Every demo phone has joined once through the invite link (registers it with Photon)
- [ ] A real card in Apple Wallet on the phone that will use Apple Pay
- [ ] Rehearse with `DEMO_MODE=true` (default): after SETTLE, payment reminders come every few minutes instead of hourly
- [ ] Start from a clean database: `rm server/data/tab.db` (or set `DATABASE_PATH` to a new file)

### Risks and backups
| Risk | What to do |
|---|---|
| Venue Wi-Fi is bad | Run the laptop on a phone hotspot. Everything goes through the internet anyway, nothing needs local network access. |
| Quick-tunnel URL changes each time `npm run phone` restarts | Start it once before presenting and don't restart (old invite and pay links stop working on restart). For a sturdier demo, deploy to Railway/Fly with a fixed domain and register it in Stripe → Settings → Payment method domains. |
| A phone isn't registered with Photon | Have them open the invite link (or run `npm run photon:register -- +1…`). Shared-line plans cap how many users a project can have (a full project returns "project is full"), and third-party write-ups mention daily new-conversation limits, so register the demo phones the day before. |
| Someone has an Android phone | iMessage only, so use iPhones for the demo. |
| Gemini is slow, busy, or out of quota | The bot rotates through 4 models and times out stuck calls. If all fail, texts still work (built-in parser) and photos get "text me the amount". Turn on billing before the demo (§6). |
| Something breaks live | Switch the laptop to `npm run sim -- --persist` and run the same script from the terminal. |

### What isn't demo-able yet
- **The native iMessage extension** (Phase 6 in PROGRESS.md). The server API it needs is done. The demo uses texts + the pay page instead.
- **Link-preview images** for pay links. iMessage still shows the link.
- **Real Solana / Connect payouts** until steps 2a / 2b are done.

---

## 5. How receipt photos are handled

**Is the photo actually read?** Yes. Every photo goes to Gemini, which labels it a *receipt*, a *chat screenshot*, or *something else*, and reads the merchant, date, line items, and total.

| You send | What the bot does |
|---|---|
| A clear receipt | Logs it with the total from the receipt. "🧾 receipt matched" means the receipt was read *and* matches any amount you typed. It counts right away for everyone in it, and anyone can reply NOPE to put their share on hold. |
| A receipt, but you typed a different amount | Logs it with **⚠️ receipt says $X** so others see the mismatch before approving |
| The same receipt twice | Logs it with **⚠️ looks like a duplicate** |
| A blurry receipt (Gemini under 50% sure of the total) | Logs nothing. Asks for a sharper photo or the amount. |
| A random picture (landscape, selfie, meme) | Logs nothing: "That doesn't look like a receipt" |
| A screenshot of a chat ("I paid $640 for the airbnb") | Logs it from the text, forwards the screenshot as evidence, but marks it **⚠️ no receipt** |
| Any photo while Gemini is down or out of quota | Logs nothing: "I can't read photos right now… text me the amount instead" |

Tested live: a drawn landscape came back "other" (rejected). A meme with "$50" in it was either rejected or read as a chat claim with no reason, so the bot asks "What was the $50 for?". In no case does a random picture become an approved debt.

**The photo is forwarded.** When an expense has a receipt or screenshot, each person in the expense gets **the photo first, then the heads-up**, so the evidence is right there. When a payer adds a receipt to settle a dispute, everyone gets the new photo with "…and added the receipt above". Photos are stored in the database (`receipt_images`) next to the expense.

## 6. Gemini limits (important for the demo)

Your key is on Google's **free tier: 20 requests per day per model**. During testing, `gemini-2.5-flash` ran out, and newer models sometimes return **503 "high demand"**. So the bot tries models in order (`GEMINI_MODEL` in `.env`):

`gemini-2.5-flash-lite → gemini-3.6-flash → gemini-3.8-flash → gemini-2.5-flash`

Flash Lite goes first because it has the most free-tier room (10 requests/minute vs 5), and it reads receipts fine (tested: $80.00 Shell in 1.2s).

**Gemini is skipped when it isn't needed.** Simple texts ("paid $80 for gas", "$45 groceries split with jake", "covered Jake's dinner $20") go through the built-in parser, and messages with no amount ("lol see you tomorrow") never reach Gemini. Only photos and tricky texts ("30 for gas and 20 for snacks", "I paid half") use it.

- Each model has its **own** daily quota, so that's roughly 80 photos/texts a day.
- A model that's busy is skipped for 1 minute. One that's out of quota is skipped for 15 minutes.
- Each call times out after 12 seconds, so a stuck model can't leave someone's text unanswered.

Text messages fall back to the built-in parser if every model fails. Photos can't, so the bot asks for the amount instead.

**Before the demo, strongly consider turning on billing** for the key (Google AI Studio → your project → set up billing). Paid tier limits are far higher, and at Flash prices a whole hackathon of receipts costs well under a dollar. Otherwise, avoid burning quota while rehearsing: use `npm run sim` with `/receipt 80 Shell` (no Gemini call) for practice runs.

## 7. Command reference (run inside `server/`)

| Command | What it does |
|---|---|
| `npm test` | All 109 tests (no network) |
| `npm run sim` | Text the bot from your terminal as different people |
| `npm run phone` | Tunnel + Stripe domain + webhooks + server, for iPhone testing and demos. The public URL's home page is the signup site. |
| `npm run preview:site` | Preview the home page, tab page, and iMessage card with fake data (http://localhost:3994: `/`, `/started`, `/error`, `/tab`, `/tab-owe`, `/t/preview/card.png`) |
| `npm run dev` | Server only (Photon + API + jobs), restarts on file changes |
| `npm run photon:register -- +1… Name` | Register a phone with Photon and print the number it should text |
| `npm run check:photon -- +1…` | Register, text yourself a hello, print replies for 2 minutes |
| `npm run check:stripe` | Live Stripe test: PaymentIntent → test card → webhook → Connect account (needs `stripe listen` on port 3997) |
| `npm run check:solana` | Live devnet test: two wallets, fund, transfer $12.34, verify balances |
| `CHECK_MINUTES=10 npm run check:photon` | Print every message the bot receives for 10 minutes |
| `npm run setup:devnet` | Create the Solana devnet treasury + tUSDC token and write them to `.env` |

### Security reminders
- Keys go in `server/.env` only. Never put them in `.env.example`, since that file is committed.
- Everything is test mode / devnet. Before using real money you'd need live Stripe keys, an embedded-wallet provider instead of server-held keys, and a fixed domain.
- Photon project credentials grant full management of the project. If they ever leak, rotate them in the Photon dashboard.
