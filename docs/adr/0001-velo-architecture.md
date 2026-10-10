# ADR-0001: Velo architecture — iMessage trip-expense agent on Photon Spectrum, Gemini and Solana

- **Status:** Accepted (HackNC 2026)
- **Date:** 2026-10-10
- **Tracks:** Best iMessage Agent with Photon · Solana · (Gemini as sponsor tech)

## Context

On group trips, one person ends up keeping a spreadsheet or a Splitwise and chasing everyone for money. Everyone already has iMessage, so expense tracking should happen there.

**Velo** is an AI agent with a real phone number. Friends on a trip text Velo to:

1. Log expenses as plain text ("I paid 120 for gas, split 4 ways") or as a receipt photo.
2. Work out who had what on a receipt, with Velo asking follow-up questions when the split is unclear.
3. See balances and a minimal "who pays whom" list.
4. Get reminder texts when they forget to pay.
5. Settle up in money that actually moves on Solana, just by texting "pay".

Constraints:
- 3-person team, about 36 hours.
- We have Photon **Spectrum Pro** (`spectrum-ts`, cloud iMessage provider).
- **On Free/Pro, Spectrum uses a shared pool of numbers.** Each end user is routed through a number from that pool, so the agent may show up as a different number for each person. Shared-pool mode **cannot create group chats** and **does not get group events**. Groups need a dedicated line (Business plan).
- **People must be registered as Users** in the Spectrum project before they can talk to the agent. This happens in the dashboard or via `POST /projects/{id}/users`, with `phoneNumber` plus optional `firstName`/`lastName`.
- Photon has **no built-in OCR or AI**. It only delivers messages and attachments.

## Decisions

### D1. Messaging: Spectrum Pro, "virtual group" over 1:1 DMs (default), with real groups as an upgrade

**Default (Option B): hub-and-spoke "virtual group".** Velo never sits in an iMessage group. A **trip** is a set of registered users that Velo keeps in its own database. Every member talks to Velo in their **own 1:1 chat**. Whenever something happens, Velo **fans out** a personalized DM to each affected member. Friends keep their normal human group chat for talking. Money stuff goes to Velo.

How the flows work in DMs:

| Flow | Who texts Velo | What Velo does |
|---|---|---|
| **Start trip** | Organizer: "start trip Asheville with Sam, Jo, Alex" | Matches names against registered Users (`firstName`). DMs each one "Alex added you to *Asheville* 🏔️. Reply JOIN". On JOIN, creates and funds their wallet. |
| **Log expense (text)** | Payer: "paid 120 for gas, everyone" | Confirms the parsed amount and split with the payer, logs it, then DMs each person included: "📌 Jo paid $120 for gas. Your share: $30." |
| **Log expense (receipt)** | Payer sends a photo | Gemini reads it. Velo replies to the payer with numbered items and asks "Split evenly with everyone on Asheville, or who had what? e.g. `1,3 Sam; 2 Jo; rest everyone`". After the payer answers, Velo fans out each person's share. |
| **Dispute** | Any member: "WRONG" / "I didn't have the wings" | Velo notifies the payer and puts the expense back into `pending` for them to fix. |
| **Balances / settle** | Anyone: "balances" or "settle" | Computes minimum transfers. DMs each debtor "You owe Alex $31.40. Reply PAY." and each creditor what they're owed. |
| **Pay** | Debtor: "PAY", then "YES" | Signs the Solana transfer, then DMs both parties with the Explorer link. |
| **Reminders** | — (cron) | DMs debtors who haven't paid. |

- **The payer decides the split**, because they know who was at dinner. Everyone else can only dispute. This keeps the conversation with one person at a time and avoids group-chat chaos.
- **Active trip:** each user has one `active_trip_id`, so "paid 40 for lunch" goes to the right trip. "switch to <trip>" changes it.
- **Identity:** names come from the registered User's `firstName`, so nobody has to introduce themselves.
- **Onboarding:** for the demo, register teammates in the Spectrum dashboard Users page. In the product, Velo calls the Create User API when the organizer names a friend by phone number ("add Sam +1919…").

**Adapter:** all Spectrum calls live in `src/messaging/spectrum.ts`, behind an interface that doesn't know about plans:
```ts
interface Messenger {
  onMessage(handler: (msg: Inbound) => Promise<void>): void; // Inbound = { userPhone, text?, attachments[], spaceId, messageId }
  sendToUser(phone: string, text: string): Promise<void>;
  sendToTrip(tripId: string, render: (member: Member) => string | null): Promise<void>; // fan-out (B) or one group message (A)
  react?(spaceId: string, messageId: string, kind: "love" | "like"): Promise<void>;
  downloadAttachment(att: Attachment): Promise<Buffer>;
}
```

**Upgrade (Option A): real group chat.** If Photon gives us a dedicated line or Business access at the hackathon, `sendToTrip` posts once into a real group created with `space.create([...members])`, and group messages go through the same router. Nothing outside the adapter changes.

**Fallback (Option C):** `@spectrum-ts/imessage-local` on a Mac signed into a spare Apple ID. It can read existing groups, but has no reactions or replies and needs the laptop awake. Emergency only.

**Why:** Option B is guaranteed to work on the plan we have. Private DMs are also arguably the *better* experience for money: nobody's debt is announced to the whole group, and reminders feel personal.

### D2. AI: Gemini for perception, deterministic code for money

- **Receipts:** download the image attachment and send it to Gemini Flash (vision) with a `responseSchema` (JSON mode):
  ```ts
  type Receipt = {
    merchant: string;
    items: { name: string; qty: number; price_cents: number }[];
    subtotal_cents: number; tax_cents: number; tip_cents: number; total_cents: number;
  };
  ```
  If the items don't add up to the subtotal within ±1¢, Velo asks the payer to confirm the total.
- **Free text:** Gemini function calling maps each message to exactly one tool:
  `start_trip`, `join_trip`, `add_expense`, `assign_items`, `dispute`, `show_balances`, `settle`, `pay`, `confirm`, `undo`, `help`.
  The prompt includes the user's active trip, its member names, and any pending question, so replies like "1,3 Sam; rest everyone" resolve correctly.
- **Hard rule: the LLM never does arithmetic.** Every amount is **integer cents**. Splits, tax/tip proration (proportional to each person's subtotal) and rounding (largest-remainder) all happen in TypeScript and are unit-tested.
- In 1:1 DMs every message is meant for Velo, so we don't need the "is this for me?" filter a group chat would need. That filter only matters again if we upgrade to Option A.

**Why:** Gemini is a sponsor and handles vision and structured output well. Keeping the money math deterministic means the numbers are always reproducible.

### D3. Payments: agent-custodied Solana wallets, devnet only

- **Wallets:** when a member joins a trip (first time only), Velo generates a `Keypair`. The secret key is encrypted with **AES-256-GCM** under `VELO_MASTER_KEY` (env var) and stored in SQLite. Plaintext keys only exist in memory while a transaction is being signed.
- **Token:** our own devnet SPL mint, **"Velo USD" (vUSD, 6 decimals, 1 vUSD = $1)**. Velo holds the mint authority and gives each new wallet 200 vUSD of test money. This avoids faucet rate limits.
- **Fees:** one Velo treasury wallet, funded with devnet SOL, is the fee payer for every transfer. Members never need SOL.
- **Paying:**
  1. The debtor texts "pay" (or replies PAY to a reminder).
  2. Velo asks: "Send 31.40 vUSD to Alex? Reply YES."
  3. On YES, Velo builds a `transferChecked` from the debtor's token account to the creditor's, signed by the debtor's key plus the fee payer.
  4. Velo waits for `confirmed`, records `tx_sig`, and DMs both people: "💸 Sam paid Alex 31.40 vUSD", with a Solana Explorer link.

**Alternatives considered:**
| Option | Why not (for this hackathon) |
|---|---|
| Solana Pay links + Phantom (no custody) | Every friend has to install and fund Phantom, which adds friction and makes the live demo fragile. |
| Escrow Anchor program ("trip vault") | Most impressive on-chain, but competes with the core agent for 36h. Kept as a stretch goal. |
| Real mainnet USDC | Real money plus custody is a legal and security problem. |

**Known risk (stated openly):** custodial keys in SQLite are fine for a devnet demo and **not OK for production**. The production path is embedded/MPC wallets (Privy, Crossmint or Turnkey) plus an "export my wallet" command. YES confirmation on every transfer stays in any version.

### D4. State: SQLite, with debt simplification at settle time

Tables:
```
users      (id, phone, first_name, pubkey, enc_secret, active_trip_id)   -- mirrors Spectrum Users
trips      (id, name, organizer_id, group_space_id NULL, created_at)     -- group_space_id only used in Option A
members    (trip_id, user_id, status)                                    -- status: invited|joined
expenses   (id, trip_id, payer_id, description, total_cents, receipt_json, status)  -- pending|logged|disputed|undone
shares     (expense_id, user_id, cents)
transfers  (id, trip_id, from_id, to_id, cents, tx_sig, status)          -- requested|sent|confirmed|failed
pending    (user_id, kind, payload_json, expires_at)                     -- per-user conversation state
```
- In Option B, conversation state is keyed by **user**, not by chat. Each person has at most one open question from Velo at a time.
- `balance(user, trip) = Σ paid − Σ owed − Σ sent + Σ received`.
- **Settle:** greedy minimum cash flow (largest debtor pays largest creditor, repeat). n people need at most n−1 transfers.

### D5. Reminders: in-process scheduler

`node-cron` runs every few hours (every 2 minutes when `DEMO_MODE=1`). Anyone who has owed money for longer than the threshold gets a friendly DM, at most once per day per trip:
> "Hey Sam 👋 you still owe Alex $31.40 from Asheville. Reply PAY to settle in one tap."

### D6. Frontend: chat-first, plus one read-only trip page

There is no app to install. One read-only page, `GET /t/:tripId`, served by Hono in the same process, shows the **shared trip feed**: every expense, each person's share, balances, and an Explorer link for every transfer. With no group chat in Option B, this page is the one place where everyone sees the whole picture. Velo links to it after each settle, and judges can see the on-chain proof without an iPhone.

## Architecture

```
Sam's iPhone ─┐                                         ┌─► agent/router (Gemini fn-calling) ◄── agent/pending (per user)
Jo's iPhone  ─┼─1:1 iMessage─► Spectrum Cloud ─► Velo ──┤        │
Alex's iPhone─┘  (shared pool)  (spectrum-ts)  service  │   receipts/parse (Gemini vision)    agent/handlers
                                                        │                                         │
       ◄──────── fan-out DMs (messaging/spectrum.ts) ◄──┘        ledger/ (split, settle) ◄──► SQLite
                                                                          │
                                                   solana/ (wallets, mint, transfer) ──► Solana devnet
                                                                          │
                                     jobs/reminders (cron) ──► DMs      web/ (Hono) /t/:tripId
```

### Repo layout
```
src/index.ts                 boot: DB, Spectrum listener, cron, web server
src/messaging/spectrum.ts    Messenger adapter (only file that imports spectrum-ts)
src/messaging/fanout.ts      sendToTrip: per-member personalized DMs
src/agent/router.ts          message → tool call (Gemini)
src/agent/handlers.ts        one handler per tool
src/agent/pending.ts         per-user awaiting_split / awaiting_confirm / awaiting_join
src/receipts/parse.ts        image → Receipt (Gemini vision + schema)
src/ledger/db.ts             schema + queries
src/ledger/split.ts          item assignment, tax/tip proration, rounding
src/ledger/settle.ts         balances + minimum transfers
src/solana/wallets.ts        keygen, encrypt/decrypt
src/solana/mint.ts           create vUSD mint, airdrop to members
src/solana/transfer.ts       transferChecked with fee payer
src/jobs/reminders.ts        cron reminders
src/web/server.ts            Hono trip page
scripts/register-users.ts    register demo phones via Spectrum Create User API
scripts/devnet-smoke.ts      mint → 2 wallets → fund → transfer → print Explorer URL
scripts/receipt-eval.ts      run Gemini over sample receipts, check totals
```

### Stack
| Concern | Choice |
|---|---|
| Runtime / language | TypeScript on Bun (or Node ≥ 20) |
| Messaging | `spectrum-ts` with the cloud iMessage provider (Spectrum Pro, shared pool) |
| AI | `@google/genai`, Gemini Flash (vision + function calling + JSON schema) |
| Chain | `@solana/web3.js`, `@solana/spl-token`, devnet RPC |
| DB | SQLite (`bun:sqlite` / `better-sqlite3`) |
| Scheduler | `node-cron` |
| Web | Hono + a single HTML template |
| Tests | Vitest |
| Hosting | Any always-on box (Railway / Fly / a laptop on the venue Wi-Fi) |

Env: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `GEMINI_API_KEY`, `SOLANA_RPC_URL`, `VELO_TREASURY_SECRET`, `VELO_MASTER_KEY`, `DEMO_MODE`.

## Demo script (the happy path we optimize for)

Cast: 4 teammates' phones, all registered as Spectrum Users with first names. The trip page is on the projector.

1. **Alex** texts Velo: "start trip Asheville with Sam, Jo, Ryan". Sam, Jo and Ryan each get "Alex added you to *Asheville* 🏔️. Reply JOIN." They reply JOIN. Velo: "wallet ready ✅ (200 vUSD test funds)".
2. **Alex** sends a dinner receipt photo. Velo: "Olive Garden, $96.40. 1) Wings $14 2) Pasta $18 … Who had what? e.g. `1,3 Sam; 2 Jo; rest everyone`".
3. Alex replies. Each of the others gets a DM: "📌 Alex paid $96.40 at Olive Garden. Your share: $27.15 (incl. tax & tip)." The trip page updates.
4. **Jo** texts "paid 120 for gas, everyone". Everyone gets their $30 share.
5. **Sam** texts "settle". Each debtor gets "You owe Alex $31.40. Reply PAY." Creditors get what they're owed.
6. **Ryan** forgets. A reminder DM arrives (demo mode). Ryan replies PAY, then YES. Alex and Ryan both get "💸 Ryan paid Alex 31.40 vUSD" plus an Explorer link. The trip page shows the confirmed transaction.

## Team split & milestones

| Person | Owns |
|---|---|
| **A: Messaging & agent loop** | Spectrum adapter + fan-out, user registration script, per-user pending state, handlers, reminders |
| **B: AI** | Receipt schema + prompt, intent tools + prompt, test set (~10 receipts, ~20 chat lines) |
| **C: Money** | SQLite schema, split/settle math + tests, Solana mint/wallets/transfer, trip page |

In hour 1, agree on the contracts: the `Messenger` interface, the `Receipt` type, the tool-call types, and the ledger function signatures. Then everyone builds against stubs.

| Hours | Goal |
|---|---|
| 0–2 | Register 4 phones · Spectrum echo bot DMs working · vUSD mint on devnet · Gemini returns Receipt JSON |
| 2–10 | start/join trip · text expense → ledger → fan-out shares · balances |
| 10–18 | Receipt flow with item assignment · custodial pay + Explorer link |
| 18–26 | Reminders · disputes · trip page · reactions polish |
| 26+ | Code freeze, rehearse the demo 5×, record a backup video |

**Hour 0 action:** ask the Photon team for a dedicated line or Business access. If we get one, enable Option A in the adapter: a real group chat, with the same core logic.

## Consequences

**Positive**
- Works on the plan we actually have (Spectrum Pro), with no dependency on group features.
- No app to install: everything happens in iMessage, which fits the Photon track.
- Private DMs suit money: nobody's debt is announced to the whole group, and reminders feel personal.
- Payments are real on-chain transfers with fast confirmation and near-zero fees, which plays to Solana's strengths.
- Deterministic money math is easy to test and explain.

**Negative / risks**
- **No shared group view inside iMessage** (Option B). Mitigated by the trip page link and by fanning out every expense. Option A removes this if we get a dedicated line.
- **Different Velo number per person** on the shared pool. This can confuse users ("why is Velo a different number for you?"). Mitigated by having each user save Velo as a contact. It's harmless for the demo.
- **Pre-registration required:** friends must be registered as Spectrum Users before Velo can message them. For the demo, this is done in the dashboard. In the product, Velo calls the Create User API when someone is added to a trip.
- **Custody:** Velo holds private keys. Mitigated by devnet only, encryption at rest, and YES confirmation. Documented as not production-ready.
- **Receipt OCR errors:** mitigated by the subtotal check, payer confirmation, and the dispute flow.

## Open questions
- Will Photon grant a dedicated line or Business access at the hackathon? (Decides Option A vs B for the demo.)
- On the shared pool, does Velo's number stay stable per user across sessions? This matters for the "save Velo as a contact" advice.
- Does the Solana track weigh custom on-chain programs heavily? If so, prioritize the "trip vault" Anchor stretch goal.
- USD only for now. Multi-currency receipts are out of scope.

## References
- Spectrum iMessage connection & routing (shared vs dedicated lines): https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing
- Spectrum Create User API: https://photon.codes/docs/api-reference/users/create-user
- Spectrum quickstart: https://photon.codes/docs/spectrum-ts/getting-started
