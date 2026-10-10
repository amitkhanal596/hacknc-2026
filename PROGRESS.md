# Tab: Implementation Progress

Tracks what's built, what's left, and what's blocked. Update it as you go: check the box, add your initials, and put a line in the log at the bottom.

**Legend:** `[x]` done · `[~]` in progress / partly done · `[ ]` not started · 🔒 blocked on credentials or access

Related docs: [PLAN.md](./PLAN.md) (what & why) · [ARCHITECTURE.md](./ARCHITECTURE.md) (how, including an "As built" section) · [server/README.md](./server/README.md) (how to run)

---

## Where things stand

The **server is built and tested end to end without any credentials**: 40 tests cover the ledger, the full Asheville scenario over DMs, the extension API, jobs, and the Apple Pay flow (against a fake Stripe). `npm run sim` lets anyone text the bot as different people from a terminal.

What's left falls into three buckets:
1. **Plug in credentials and verify against the real services** (Photon, Gemini, devnet, Stripe). The code paths exist but have only run against stand-ins.
2. **The iOS iMessage extension** (not started). The API it needs is done.
3. **Polish:** link-preview images, deploy, demo script.

## Credentials & access checklist
| Item | Needed for | Status |
|---|---|---|
| Photon Spectrum project ID + secret | Real iMessage DMs | 🔒 |
| Gemini API key | Reading receipts/screenshots, smarter text parsing | 🔒 (regex fallback works for text) |
| Stripe sandbox (Connect enabled) + keys | Apple Pay + payouts | 🔒 |
| Stable HTTPS deploy URL (Railway/Fly) | Apple Pay domain, webhooks, extension API | 🔒 |
| Solana devnet treasury (`npm run setup:devnet`) | Real USDC transfers | [ ] script ready, not run yet |
| iPhone + Xcode free provisioning | iMessage extension | [ ] |

---

## Phase 0: Spike (H0–2)
- [ ] Spectrum: receive a DM, send a DM, get the sender's phone number 🔒
- [ ] Spectrum: download an image attachment (JPG + HEIC) 🔒
- [ ] Spectrum: can the bot text a number that never texted it? 🔒 (design doesn't need it)
- [ ] Spectrum: outbound rate limits 🔒
- [ ] Stripe: Apple Pay button shows on the deployed domain in iPhone Safari 🔒
- [ ] Stripe: Connect (Accounts v2) onboarding completes in test mode 🔒
- [ ] Solana: run `npm run setup:devnet` (treasury + tUSDC mint)
- [ ] Xcode: iMessage App template runs on a phone

## Phase 1: Server foundation
- [x] `server/` scaffold: Node 22, TypeScript, tsx, vitest
- [x] `config.ts`: zod env parsing; missing keys turn features off
- [x] DB schema (Drizzle + better-sqlite3 v12) + migrations on boot
- [x] Messaging interface + in-memory adapter + **terminal simulator** (`npm run sim`)
- [~] Spectrum adapter (`messaging/spectrum.ts`): written against spectrum-ts 12.10 types, typechecks, **not run against real Photon yet** 🔒

## Phase 2: Ledger (pure logic, unit tested)
- [x] `splits.ts`: equal / custom, cent-exact; payer absorbs leftover cents
- [x] `settle.ts`: pairwise debts (+ optional `simplify()`), zero-sum invariant
- [x] `validate.ts`: reason required, amount mismatch (larger of $1 / 5%), duplicate detection, no-receipt flag
- [x] `approvals.ts`: owner-only approve/dispute, auto-approve only with receipt, edits reset shares, audit log

## Phase 3: Bot (1:1 DMs)
- [x] Command parser: NEW, JOIN, USE, GROUPS, NAME, BALANCE, SETTLE, PAY, WHY, YES, DISPUTE, FIX, WITHDRAW, PAYOUTS, HELP
- [x] Groups: create, join codes, `sms:` invite link, active group, name capture, join announcements
- [x] Expense capture from text (Gemini with regex fallback)
- [~] Expense capture from images: receipts + chat screenshots. Pipeline done and tested with fake receipts; **real photos need Gemini** 🔒
- [x] Approval DMs to each person, batched (YES ALL / YES 1 3 / DISPUTE 2 reason)
- [x] Prompts per kind so bare replies resolve safely ("what was the $20 for?" → "firewood")
- [x] Disputes → payer can FIX $amount, WITHDRAW, or send a receipt photo; everyone re-approves
- [x] WHY explanations (deterministic, from records only)
- [x] Settle-up DMs with both payment options

## Phase 4: Payments
- [x] Payment router: cap at approved debt minus in-flight payments; records; confirmations to both sides
- [x] Solana: wallet creation + AES-256-GCM key encryption
- [x] Solana: `scripts/setup-devnet.ts` (treasury, tUSDC mint, airdrop) — written, not run yet
- [~] Solana: fund new wallets, `transferChecked` with treasury as fee payer. Written; tested only via `SimulatedChain`. Needs a devnet run.
- [x] Signed pay-link tokens (HMAC, 24h expiry)
- [~] Stripe: PaymentIntent for Apple Pay (destination charge, or held on platform) — tested with a fake Stripe 🔒
- [~] Stripe: Connect onboarding with **Accounts v2** (recipient config, Express dashboard) + return/refresh pages 🔒
- [~] Stripe: webhook handler (succeeded, failed, account.updated, transfer.created) — tested with fake events 🔒
- [~] Stripe: release held transfers (`source_transaction`) — tested with a fake Stripe 🔒
- [~] Pay page (`/p/:token`): breakdown + Express Checkout Element (Apple Pay) + "pay with USDC". Renders and pays USDC in tests; Apple Pay button needs a real key + Safari 🔒

## Phase 5: API + jobs
- [x] Auth: one-time code texted through the bot → bearer token
- [x] Extension REST API (groups, expenses, detail + audit, approve/dispute own share only, explain, pay, pay link, onboarding)
- [x] Jobs: auto-approve, reminders (debt + review) with backoff, held-payment sweep, stale Apple Pay expiry
- [ ] Daily digest
- [ ] Link-preview / card images (`/og/...`)

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
- [ ] Deploy (Railway/Fly) + domain registered with Stripe 🔒
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
npm test                  # 40 tests
npm run sim               # local DM simulator, no Spectrum needed
npm run dev               # real server (Spectrum + HTTP API + jobs)
```

## Decisions made during implementation
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
