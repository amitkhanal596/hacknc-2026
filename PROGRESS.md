# Tab: Implementation Progress

Tracks what's built, what's left, and what's blocked. Update it as you go: check the box, add your initials, and put a line in the log at the bottom.

**Legend:** `[x]` done · `[~]` in progress / partly done · `[ ]` not started · 🔒 blocked on credentials or access

Related docs: [PLAN.md](./PLAN.md) (what & why) · [ARCHITECTURE.md](./ARCHITECTURE.md) (how, including an "As built" section) · [server/README.md](./server/README.md) (how to run) · **[TESTING.md](./TESTING.md) (keys, live tests, iPhone + demo guide)**

---

## Where things stand

The **server is built and tested**, with live checks against Gemini, Stripe, Photon, and Solana devnet (see [TESTING.md](./TESTING.md)). 51 tests cover the ledger, the full Asheville scenario over DMs, the extension API, jobs, the Apple Pay flow (against a fake Stripe), receipt-photo forwarding, and the Gemini fallback chain. `npm run sim` lets anyone text the bot as different people from a terminal.

What's left:
1. **Three quick manual steps** ([TESTING.md §2](./TESTING.md#2-the-three-things-only-you-can-do-5-minutes-total)): devnet faucet SOL, Stripe Connect loss-liability acknowledgement, register your phone with Photon.
2. **Verify on real phones:** a DM round trip and the Apple Pay sheet.
3. **The iOS iMessage extension** (not started). The API it needs is done.
4. **Polish:** link-preview images, fixed-domain deploy, demo rehearsal.

## Credentials & access checklist
| Item | Needed for | Status |
|---|---|---|
| Photon Spectrum project ID + secret | Real iMessage DMs | [x] connects (Pro plan, shared line) |
| Register organizer's phone with Photon | Texting the bot on a shared line | [ ] `npm run photon:register -- +1… Name` |
| Gemini API key | Reading receipts/screenshots, smarter text parsing | [x] verified on a real receipt photo |
| Stripe sandbox keys + webhook secret | Apple Pay | [x] live PaymentIntent + webhook verified |
| Stripe Connect platform profile (loss liability) | Payouts to the person owed | [ ] Dashboard step (TESTING.md 2b) |
| HTTPS URL | Apple Pay domain, webhooks, links on phones | [x] `npm run phone` (cloudflared quick tunnel); fixed deploy still [ ] |
| Solana devnet treasury | Real USDC transfers | [~] wallet + secrets generated; needs faucet SOL, then `npm run setup:devnet` |
| iPhone + Xcode free provisioning | iMessage extension | [ ] |

---

## Phase 0: Spike (H0–2)
- [x] Spectrum: credentials connect; project is on a **shared** line (each user must be registered, may get a different number)
- [x] Spectrum: the bot can text a number first **once it's registered** (join page does this)
- [x] Spectrum: real DM round trip with an iPhone, including sending a photo (inbound "hi", outbound text + image)
- [x] Stripe: tunnel domain registered with Apple Pay status **active**
- [ ] Stripe: Apple Pay sheet on a real iPhone
- [x] Stripe: Connect payout account + onboarding link created live (after the Dashboard step)
- [x] Solana: treasury funded, tUSDC mint created, real transfers verified (`npm run check:solana`)
- [ ] Xcode: iMessage App template runs on a phone

## Phase 1: Server foundation
- [x] `server/` scaffold: Node 22, TypeScript, tsx, vitest
- [x] `config.ts`: zod env parsing; missing keys turn features off
- [x] DB schema (Drizzle + better-sqlite3 v12) + migrations on boot
- [x] Messaging interface + in-memory adapter + **terminal simulator** (`npm run sim`)
- [~] Spectrum adapter (`messaging/spectrum.ts`): connects to real Photon; inbound/outbound round trip still to be checked from a phone
- [x] Photon shared-line support: user registration (`messaging/photon-users.ts`), web join page `/j/:code`, `npm run photon:register`

## Phase 2: Ledger (pure logic, unit tested)
- [x] `splits.ts`: equal / custom, cent-exact; payer absorbs leftover cents
- [x] `settle.ts`: pairwise debts (+ optional `simplify()`), zero-sum invariant
- [x] `validate.ts`: reason required, amount mismatch (larger of $1 / 5%), duplicate detection, no-receipt flag
- [x] `approvals.ts`: owner-only approve/dispute, auto-approve only with receipt, edits reset shares, audit log

## Phase 3: Bot (1:1 DMs)
- [x] Command parser: NEW, JOIN, USE, GROUPS, NAME, BALANCE, SETTLE, PAY, WHY, YES, DISPUTE, FIX, WITHDRAW, PAYOUTS, HELP
- [x] Groups: create, join codes, web invite link (`/j/:code`), active group, name capture, join announcements
- [x] Expense capture from text (Gemini with regex fallback)
- [x] Expense capture from images: verified with real Gemini on real receipts; random pictures rejected; low-confidence totals asked about
- [x] Receipt photo forwarded to everyone asked to approve (and on dispute fixes); stored in `receipt_images`
- [x] Gemini model chain (3.8 → 3.5 → 2.5 → 2.5-lite) with 12s timeouts and cooldowns; free tier is 20 req/day/model
- [x] Heads-up DM to each person with their share + running total (no approval step); NOPE to flag; payment asks only after SETTLE
- [x] Prompts per kind so bare replies resolve safely ("what was the $20 for?" → "firewood")
- [x] Disputes → payer replies with a new amount in plain words ("$30 is fine", "make it 40"), ACCEPTs the disputer's suggested amount, WITHDRAWs, or sends a receipt photo; same-named new expense updates the disputed one instead of duplicating; BALANCE lists open disputes
- [x] WHY explanations (deterministic, from records only)
- [x] Settle-up DMs with both payment options

## Phase 4: Payments
- [x] Payment router: cap at approved debt minus in-flight payments; records; confirmations to both sides
- [x] Solana: wallet creation + AES-256-GCM key encryption
- [~] Solana: `scripts/setup-devnet.ts` writes secrets to `.env`; treasury created, mint waits on faucet SOL
- [~] Solana: fund new wallets, `transferChecked` with treasury as fee payer. Written; tested only via `SimulatedChain`. Needs a devnet run.
- [x] Signed pay-link tokens (HMAC, 24h expiry)
- [x] Stripe: PaymentIntent for Apple Pay — verified live (test card) + webhook marks it held/confirmed
- [~] Stripe: Connect onboarding with **Accounts v2** — code done; account creation blocked until the Dashboard loss-liability step
- [x] Stripe: webhook handler — `payment_intent.succeeded` verified live through `stripe listen`
- [~] Stripe: release held transfers (`source_transaction`) — tested with a fake Stripe 🔒
- [~] Pay page (`/p/:token`): breakdown + Express Checkout Element (Apple Pay) + "pay with USDC". Renders and pays USDC in tests; Apple Pay button needs a real key + Safari 🔒

## Phase 5: API + jobs
- [x] Auth: one-time code texted through the bot → bearer token
- [x] Extension REST API (groups, expenses, detail + audit, approve/dispute own share only, explain, pay, pay link, onboarding)
- [x] Jobs: auto-approve, reminders (debt + review) with backoff, held-payment sweep, stale Apple Pay expiry
- [ ] Daily digest
- [x] Tab summary: SUMMARY / "what are my expenses" → text + rich link card (`/t/:token`, `/t/:token/card.png`) opening a "Your Tab" page

## Phase 6: iMessage extension (Swift)
- [ ] Xcode project (`ios/Tab`) with Messages extension
- [ ] Login (phone → code → Keychain token) — API ready: `/auth/start`, `/auth/verify`
- [ ] Group picker + conversation mapping — API ready: `/api/groups`
- [ ] Compact + expanded GroupView — API ready: `/api/groups/:id`
- [ ] Review queue (Approve / Dispute) — API ready: `/api/shares/:id/approve|dispute`
- [ ] Expense detail (why + audit trail) — API ready: `/api/expenses/:id`, `/api/explain`
- [ ] Pay (USDC via `/api/pay/solana`; Apple Pay opens `/api/pay/link` URL)
- [ ] Add expense (camera → multipart `/api/groups/:id/expenses`)
- [ ] MSMessage cards for the group chat

## Phase 7: Demo polish
- [x] `npm run phone`: tunnel + Stripe Apple Pay domain + webhooks + server in one command
- [x] TESTING.md: iPhone testing + in-person demo guide
- [x] Home page / signup site (Frutiger Aero): get your Tab number, text/save-contact buttons, QR code on laptops (`/`, `/start`, `/contact.vcf`; `npm run preview:site`)
- [~] Deploy to Railway: repo prepared (`railway.json`, prod start, Node 22, `npm run setup:stripe`); follow [DEPLOY.md](./DEPLOY.md)
- [ ] Seed script for a demo group
- [ ] Demo script (Asheville scenario) rehearsed on 3 phones
- [ ] Demo video

## Stretch
- [ ] Itemized restaurant splits (`expense_items` table exists, unused)
- [ ] Recurring roommate bills
- [ ] Club dues mode
- [ ] Apple Pay → USDC on-ramp
- [ ] Native PassKit Apple Pay in the extension
- [ ] "Simplify debts" group setting (uses `simplify()`)

---

## How to run (server)
```bash
cd server
npm install
cp .env.example .env      # fill in whatever keys you have; missing ones fall back to stubs
npm test                  # 51 tests
npm run sim               # local DM simulator, no Spectrum needed
npm run dev               # real server (Spectrum + HTTP API + jobs)
```

## Decisions made during implementation
- **Invites are a web join page, not "text this number".** Photon's shared line only talks to registered numbers and can give each person a different number. The join page registers the phone with Photon, then the bot texts them first.
- **Node 22 + tsx instead of Bun.** Node is already installed and Bun isn't. Same TypeScript; `vitest` for tests.
- **better-sqlite3 pinned to v12.** v13 segfaults on Node 22.11.
- **npm override: `rpc-websockets` uses uuid v11.** `@solana/web3.js` pulls in an ESM-only uuid that Node < 22.12 can't `require()`.
- **Pairwise debts instead of fewest-transfers.** "Why do I owe Priya?" must trace to Priya's expenses. `simplify()` is kept for a future setting.
- **WHY is a template, not an LLM.** It can't invent anything. Gemini is only used to *understand* input.
- **Payer is always the sender.** Logging "Jake paid $40" on Jake's behalf isn't supported, which keeps approvals simple and prevents logging debts for someone else.
- **Stripe Connect uses Accounts v2** (recipient configuration, Express dashboard, platform owns fees/losses). Readiness = `stripe_transfers.status === "active"`, re-checked from the webhook, the return page, and a sweep job (so a demo works even if webhooks aren't forwarded).
- **Abandoned Apple Pay attempts expire after 30 minutes** so they stop blocking the debt. A late `succeeded` webhook still counts.
- **"What was the $X for?" waits 15 minutes and at most 5 words**, so a later unrelated text isn't logged as an expense.

## Known gaps / risks
- Spectrum adapter assumptions to verify: `message.sender.id` is the E.164 phone, `imessage(app).space.create(phone)` opens a DM, image attachments arrive as `attachment` content with `read()`.
- `GEMINI_MODEL` defaults to `gemini-2.5-flash`. Set it to whatever current Flash model your key has access to.
- With two quick YES replies racing, approvals are idempotent but messages could double up. Fine for a demo.
- Wallet keys are held by the server (encrypted). Devnet only.

## Log
| Date | Who | What |
|---|---|---|
| 2026-10-10 | AK + Claude | Created PROGRESS.md. Starting Phase 1 (server foundation) and Phase 2 (ledger). |
| 2026-10-10 | AK + Claude | Built the server: ledger, DM bot, Gemini/regex extractors, Solana (real + simulated), Stripe Apple Pay + Connect v2, extension API, pay page, jobs, simulator. 40 tests passing. Docs updated with an "As built" section. |
| 2026-10-10 | AK + Claude | Keys set up in `server/.env` (Gemini, Stripe + webhook secret, Photon, generated secrets, Solana treasury). Installed Stripe CLI + cloudflared. Live-tested Gemini (receipt photo), Stripe (PaymentIntent + webhook), Photon (connect). Found Photon shared-line rules → added user registration + web join page. Added `npm run phone`, check scripts, TESTING.md. 44 tests. |
| 2026-10-10 | AK + Claude | Live end-to-end on a real iPhone (Photon both ways, real devnet PAY, Stripe Connect). Join page now hands people a pre-filled JOIN text (shared lines need them to text first). Receipt photos forwarded to approvers; random pictures rejected; Gemini model chain + timeouts after hitting the free-tier 20/day limit. 51 tests. |
| 2026-10-10 | AK + Claude | Frutiger Aero home page replaces `npm run photon:register` for organizers: enter name + number → Tab number, text/save-contact buttons, QR for the demo table. 56 tests. |
| 2026-10-10 | AK + Claude | Fixed the dispute dead-end found in live testing ("$30 is fine" created a new expense, re-logging made a duplicate). Natural fix replies, ACCEPT suggested amount, dedupe, BALANCE shows disputes, "X owes me" = X owes all. 70 tests. |
| 2026-10-10 | AK + Claude | Running-tab model: expenses count immediately, heads-up with share + running total (receipt photo first), NOPE instead of DISPUTE (payer: new amount / OK / REMOVE / receipt), payment requests and reminders only after SETTLE. 74 tests. |
| 2026-10-10 | AK + Claude | "What are my expenses" → summary text + Partiful-style rich card (satori/resvg PNG) opening a Frutiger Aero "Your Tab" page with netting per person. Confirmed netting: $20 vs $25 → one $5 payment. 79 tests. |
| 2026-10-10 | AK + Claude | Fixed bugs from a live iPhone trip: "paid ayug's meal" now means Ayug owes it all (Gemini rule + regex fallback); Gemini 504 timeouts fall through to the next model; payer can fix who an expense was for ("that was just for Ayug", "only Jake and me", "split it with everyone"); a second SETTLE within 10 min doesn't re-text everyone. 93 tests. |
