# TAB — ONE-SHOT AUTONOMOUS BUILD SPECIFICATION FOR ASTRA

You are Astra operating inside my VS Code workspace as a principal software architect, senior full-stack engineer, payments engineer, and test engineer. **Implement the project in the repository, not just describe a plan.** Do not stop after writing an architecture document. Inspect the repository, implement the code, add tests, run available checks, fix failures, and leave the application in the most runnable state possible.

## 0. Operating rules — read first

- Project name: **Tab**. Hackathon: HackNC 2026. Scope: **a 24-hour MVP for a 2–4 person team**. Starting repository may contain only a README. The primary experience is an AI expense assistant in an existing **iMessage group chat via Photon Spectrum**. The application recognizes group expenses and receipt photos, calculates fair splits and outstanding debts, and helps friends settle up.
- **Solana is the actual blockchain implementation and centerpiece of the payment demo**. But the business/domain architecture must also support **Venmo, Apple Cash, Zelle, cash, and future providers** without schema rewrites or changes to the expense engine.
- Prioritize **zero unnecessary onboarding**: No Tab account, app installation, bank linking, or crypto wallet is needed merely to appear in the trip, add an expense, or see a basic group summary. Users set up a payment method only if they elect to settle through it. Authentication/authorization is still mandatory for accessing private information and moving money.
- **Never invent a third-party capability**. You cannot programmatically initiate or verify personal Venmo/Zelle/Apple Cash peer-to-peer payments via an undocumented backend integration. For those rails, provide safe user-facing instructions, official profile/QR details where available, a sender's "I paid" claim, and independent confirmation by the authenticated recipient. A screenshot is evidence, **not payment verification**. Apple Pay merchant checkout is NOT Apple Cash person-to-person. Apple FinanceKit access is limited and requires Apple-granted entitlement and consent; it is out of scope.
- **No production custody or real-fund automation.** On Solana, implement a genuine devnet SPL token transfer demo using clearly labeled fake **TAB Test USD (tUSD)**. Devnet-only hosted wallets may be used solely for the demo, provisioned lazily and encrypted at rest; forbid that mode in mainnet. Do not label the custom token USDC or claim a test transfer moved real dollars. Architect for future external/noncustodial wallets and authentic USDC, but do not claim to have deployed them.
- **Money movement always requires a unique, authenticated, explicit approval of a specific payment intent.** A plain "PAY" message must NEVER unconditionally execute a transfer. Never make a payment based on AI output. Do not allow the LLM to sign transactions, perform balance mutations, or change payment status.
- **Be autonomous**. Inspect existing code first. Preserve working code and conventions. Do not ask broad clarification questions; make a reasonable documented decision. Credentials will not necessarily be available: implement a deterministic demo/simulator path, leave `.env.example`, and report exactly what needs credentials. Do not fabricate live integration success.
- Use current official SDK types and docs, inspect installed type definitions, and compile. In particular, Photon/Gemini SDKs evolve rapidly. If a described feature is unsupported, implement a clean adapter and graceful fallback; do NOT hallucinate methods, fake behavior, or mark mocked integration as production-ready.
- At each important step, run a relevant test/typecheck. At the end run all executable checks and report pass/fail, unavailable credentials, and actual limitations. No secrets in git, logs, errors, QR codes, or receipts.

## 1. User experience and success story

The demo has four friends in an iMessage group planning a trip:

1. `@tab create trip Tahoe, Nov 13–16` creates or identifies the group ledger and posts a concise intro.
2. A member says `@tab I paid $120 for groceries, split with everyone`. The AI returns a **proposed** expense with payer, total, members, and shares. The real payer (or authorized owner) confirms the specifically identified expense. For four people, all four have a $30 share, leaving the purchaser a net $90 credit and three people owing $30 each.
3. Someone sends a photo of a dinner receipt with `@tab split this`. Gemini vision classifies the image, extracts merchant, line items, subtotal, tax, tip, and total, but does **not** assume the sender paid. If payer or participants are ambiguous, ask one narrow question. The expense is NOT entered as confirmed until authorized confirmation.
4. `@tab balances` produces each person's net owed/owing amount. `@tab settle` computes a deterministic, non-negative, integer-cent settlement proposal across all confirmed expenses and confirmed prior payments. It does not mutate debt until payments are confirmed.
5. Person B chooses **Solana**, approves an exact devnet tUSD payment through an authenticated private pay page. The server signs a devnet-only test transfer (or builds a wallet-signed request if supported), and verifies the exact transaction before applying a settlement credit. UI shows **on-chain verified (devnet test token)** and an explorer link.
6. Person C chooses **Venmo**: Tab shows the verified recipient's handle/QR (if present), amount, and purpose, with a copy action and safe open-profile flow where supported. C pays independently in Venmo, then taps `I've paid`; the intended recipient confirms having received the transfer; only then is the settlement treated as recipient-confirmed. No fake API verification.
7. Person D chooses **Apple Cash** or **Zelle**: show clear manual instructions using the recipient's chosen, confirmed contact information; no invented deep links. Same independent recipient-confirmation flow. Cash is also supported.
8. The bot posts a group-level update such as `3 of 3 settlements resolved` without leaking sensitive payment credentials. An optional private view lists each user's detailed obligations and method-specific status.

Minimum successful demo: **one actual confirmed devnet transaction + one recipient-confirmed Venmo/Apple Cash/Zelle-style payment + a verified correct zero-balance outcome**. A demo simulator must work even if Photon or Gemini API keys are absent, visibly labeled simulation.

## 2. Architecture — keep domain independent of payment provider

```
       Existing iMessage group     Mobile browser (pay/dashboard)
                 |                            |
        Photon Spectrum adapter             Hono API
                 |                            |
          normalized events <-----> Auth / group membership
                 |                            |
       Candidate filter / image classifier   |
                 |                            |
             Gemini AI                       |
      text + receipt structured proposals    |
                 |                            |
          Zod validation / member resolution |
                 |                            |
        Proposal + approval workflow          |
                 \                           /
                  Domain services / Ledger
                   |        |         |
              Expenses   Netting    Payment intents
                   |        |         |
                SQLite + Drizzle + audit/outbox
                                      |
                               PaymentRail registry
                          /            |            \
                   Solana devnet    Manual rails    Future
                REAL verified tx  Venmo/AppleCash/  Bank APIs
                                  Zelle/Cash
                                   recipient-confirmed
```

Hard separation:
- **AI interpretation** creates structured *proposals*, never trusted accounting writes.
- **Ledger domain** owns balances, integer-cent splitting, revisions, and auditable state.
- **Settlement domain** owns netting, unique intents, debt-application, and idempotency.
- **Provider adapters** own payment instructions, optional execution, and provider-specific proof. No method-specific logic in `splits.ts`, `settle.ts`, or DB net-balance queries.
- **Presentation** distinguishes `verified_on_chain`, `confirmed_by_recipient`, `claimed_by_sender`, `pending`, and `failed`. Never display all as identical 'verified' badges.

## 3. Selected stack and project layout

- Runtime/server: **Bun + TypeScript (strict)**, **Hono** REST API, Zod for validation.
- DB: **SQLite + Drizzle ORM** for a single durable hackathon server; repository interfaces should allow future PostgreSQL migration. Use a persistent volume; don't assume ephemeral hosting preserves SQLite.
- Messaging: **Photon Spectrum (`spectrum-ts`)** with iMessage provider. Read installed/current docs. A `MockMessagingAdapter` must simulate inbound text, photos and outbound messages for development/demo.
- AI: **Google Gemini Flash using `@google/genai` and the currently supported structured output API**, Zod parse/validation. Choose a currently supported Flash model through environment config; do not pin an invented model name. Mock fixture parser fallback when credentials absent.
- Solana: **`@solana/web3.js` + `@solana/spl-token` for genuine devnet demo transfers**. Use `@solana/pay` selectively for external wallet links/QR only if verified on the target wallets/network; support a reliable direct SPL-transfer demonstration. Follow official current package APIs.
- Web: **React + Vite + TypeScript**, mobile-first, simple polished UI, ideally served statically with the API or configured for local two-process development. No native iMessage extension on the critical path. A SwiftUI Messages extension is stretch-only after the working demo passes.
- Tests: `bun test` unit/integration; mocks for third-party SDKs; RPC tests gated behind env credentials; scripts for seed/demo/smoke.

Suggested layout (adjust if repo already has code):

```
README.md
.env.example
package.json
bun.lock
server/
  src/index.ts
  src/config.ts
  src/api/{app,routes,auth,errors}.ts
  src/messaging/{types,photon,mock,handler}.ts
  src/ai/{classifier,extractor,schemas,gemini,mock}.ts
  src/domain/{money,split,balances,settle,expenses,payment-intents}.ts
  src/payments/{types,registry,service,manual,solana-devnet,solana-external}.ts
  src/solana/{rpc,wallets,mint,transfer,verify}.ts
  src/db/{schema,client,migrations,seed}.ts
  src/security/{identity,tokens,authorization}.ts
  src/jobs/{reconcile,reminders}.ts
  src/demo/{scenarios,fixtures,simulator}.ts
  src/test/{...}.test.ts
web/
  src/{app,pages,components,api,styles}.tsx
  ...
scripts/{setup-devnet,smoke-demo}.ts
docs/{ADR,ARCHITECTURE,IMPLEMENTATION_PLAN,PAYMENT_RAILS,DEMO_SCRIPT}.md
```

## 4. Database and accounting invariants

Create Drizzle schema/migrations with indexes, uniqueness constraints, and foreign keys. Use integer cents (`INTEGER`) for USD amounts, and BigInt/string at the Solana base-unit boundary. Never use floating point for currency arithmetic. Currency code is explicit, USD only for MVP; fail for unsupported currencies.

Entities:

1. `users`: `id`, `display_name`, `created_at`. Do NOT assume `phone` is always present, stable, or authorized. No wallet for non-paying users.
2. `messaging_identities`: `id`, `user_id`, `provider`, `provider_user_id`, `verified_by_provider`, timestamps; unique `(provider,provider_user_id)`. A group sender is a platform identity, not a funds authorization by itself.
3. `groups`: `id`, `provider`, `provider_space_id`, `name`, `trip_metadata_json`, timestamps; unique provider/space pair.
4. `group_members`: `group_id`, `user_id`, `role`, timestamps; unique pair. If Photon doesn't expose full participant list reliably, create users as they post or join and expose a safe admin invitation/add path; don't fabricate nonexistent members.
5. `expenses`: `id`, `group_id`, `payer_user_id NULLABLE`, `description`, `currency`, `total_cents`, `status [pending,confirmed,rejected,voided]`, `source_message_id`, `created_by`, `confirmed_by`, `confirmed_at`, `version`, timestamps.
6. `expense_shares`: `expense_id`, `user_id`, `share_cents` (unique pair). Shares must sum exactly to total, including the payer's share when included.
7. `expense_items` (stretch): `expense_id`, item name, amount, quantity, ordered position; per-user claims in join table if itemized splitting is implemented.
8. `receipt_assets`: `id`, `group_id`, `expense_id NULLABLE`, access-controlled storage key, digest, mime, parser status and redacted extracted fields. Never expose raw screenshots in public OG previews.
9. `payment_destinations`: `id`, `user_id`, `method [solana,venmo,apple_cash,zelle,cash]`, `handle_or_address`, `display_hint`, `verified_for_display`, timestamps; self-owned; recipient can control availability. No raw bank numbers. Payment handle must be checked before displaying instructions; do not auto-assume chat phone is enrolled for Zelle/Apple Cash.
10. `settlement_intents`: `id`, `group_id`, `from_user_id`, `to_user_id`, `currency`, `amount_cents`, `amount_confirmed_cents`, `status`, `expires_at`, `version`, `created_at`, `updated_at`, `idempotency_key`. A settlement is a debt/transfer request, **not a payment rail**. Avoid multiple simultaneous active intents for the same settlement plan causing duplicated obligations. Either version/revoke old plans or reconcile outstanding intents when recomputing.
11. `payment_attempts`: `id`, `intent_id`, `method`, `amount_cents`, `status`, `external_reference`, `tx_signature`, `network`, `token_mint`, `recipient_destination_snapshot`, `sender_claimed_at`, `recipient_confirmed_at`, `verified_at`, `failure_reason`, `idempotency_key`; unique `tx_signature` where not null. Multiple attempts can exist per intent, but at most one applies a given payment to the ledger.
12. `payment_evidence`: `id`, `attempt_id`, `type [image,transaction_reference,manual_note]`, private asset, extracted proposed fields, uploader, timestamps. Evidence DOES NOT imply verification.
13. `payment_events` / `audit_events`: append-only event ledger for request, authorization, provider submission, claim, recipient confirmation, chain verification, cancellation, corrections. Include actor and timestamps.
14. `processed_messages`: `(provider,provider_message_id)` uniqueness, group, processing state, timestamps; idempotent ingestion.
15. `one_time_tokens` / `auth_challenges`: hashed opaque tokens, intended user, purpose, expires, consumed. Use proper randomness and expiry; no raw tokens in logs.
16. `reminder_state`: group/member, last reminder, attempts, preferences. Opt-out and sensible rate limits.

Balance formula (positive = net creditor):

`net(user) = sum(total for expenses the user paid) - sum(user shares across confirmed expenses) + sum(confirmed outgoing settlements) - sum(confirmed incoming settlements)`.

Clarification: an outgoing payment moves a debtor's negative balance toward zero, and an incoming payment moves a creditor's positive balance toward zero. `sum(net(user) for group) === 0` in integer cents. Only `confirmed_by_recipient` or successfully `verified_on_chain` money movements affect balances. Pending and sender-claimed payments do not.

Invariant examples:
- $100 / 3 participants -> deterministic `[3334,3333,3333]` cents, sum $100 exactly.
- Duplicate Photon event, image re-upload, confirmation retry, pay-button double click, and RPC timeout must not create duplicate expenses, debts, or transfers.
- If a user paid an expense and is also included in the split, only other members owe their portions; the ledger yields the right net automatically.
- Negative expenses, invalid user IDs, over-confirming, paying oneself, unsupported currencies, duplicate chain signatures, and missing membership are rejected.
- Payment corrections never silently modify confirmed historic expenses; create auditable adjustments/void-and-replace events.

## 5. Formal provider abstraction — implement this, not scattered if/else

Design a TypeScript `PaymentRail` interface, adapting exact types as necessary:

```ts
type PaymentMethod = "solana" | "venmo" | "apple_cash" | "zelle" | "cash";
type VerificationKind = "on_chain" | "recipient_confirmation";
type AttemptStatus =
  | "draft" | "awaiting_authorization" | "ready_for_external_payment"
  | "submitting" | "submitted" | "sender_claimed"
  | "recipient_confirmed" | "onchain_verified" | "failed"
  | "expired" | "cancelled" | "disputed";

type PaymentCapability = {
  method: PaymentMethod;
  verification: VerificationKind;
  canExecuteFromBackend: boolean;
  requiresRecipientDestination: boolean;
  userFacingDescription: string;
};

type PaymentInstructions = {
  method: PaymentMethod;
  recipientLabel: string;
  amountCents: number;
  instructionLines: string[];
  verifiedUrl?: string;        // only if officially supported and safely validated
  qrAssetUrl?: string;         // known recipient QR, not fabricated
  copyableRecipient?: string;
  copyableAmount: string;
  safetyNotice?: string;
};

interface PaymentRail {
  readonly capability: PaymentCapability;
  prepare(intent: SettlementIntent, destination: PaymentDestination | null): Promise<PaymentInstructions>;
  // Solana implementation only; manual rails should have no executable funds transfer.
  executeAuthorized?(attempt: PaymentAttempt, auth: AuthorizedActor): Promise<ProviderResult>;
  verify?(attempt: PaymentAttempt): Promise<VerificationResult>;
}
```

Required rules:
- **Settlement service** creates an immutable/uniquely identified intent (payer, recipient, precise amount, group, expiry). User chooses a method later; method selection creates a child attempt.
- **Solana rail**: actual devnet transaction plus on-chain verification of recipient, token mint, source/destination, amount, transaction success and finality; unique signature cannot settle two intents. Use a unique payment reference or auditable per-attempt association where supported. Log tx signature, not private keys.
- **ManualRail**: reusable engine for Venmo, Apple Cash, Zelle, cash with distinct instructions and recipient destinations. `executeAuthorized` MUST NOT exist/execute for these methods. Sender's claimed proof -> `sender_claimed`. The **recipient**, independently identified and authorized, can confirm receipt -> `recipient_confirmed`. A sender cannot confirm their own outgoing payment, even if they send a screenshot.
- Provide `getInstructions`, `submitPaymentClaim`, `confirmReceipt`, `dispute`, and `getStatus` API/service operations that work regardless of method. UI must reflect distinct verification levels.
- Don't auto-create Venmo handles, Apple Cash addresses, Zelle recipient contacts, or pretend verified payment deeplinks. Venmo's **official profile QR** can be stored and used with the recipient's consent. Apple Cash is completed natively in Messages/Wallet; Zelle in the participating bank app; show manual steps and a safe copy action. If a recipient has not configured a destination, request it just-in-time or allow an alternate method.
- Future bank/payment integrations should only have to implement `PaymentRail` and register a capability; existing domain tables and algorithms remain unchanged.
- Only a successfully verified or recipient-confirmed `payment_attempt` can apply an accounting credit, exactly once in a DB transaction. Protect against confirmation races and simultaneous mixed-rail attempts. If an intent has multiple methods attempted, only one resolution path is applied for each settled amount. Ideally support partial payments with exact residual tracking; if too complex for MVP, reject partial amounts cleanly and leave a documented extension point.

## 6. Solana devnet primary implementation

- `SOLANA_CLUSTER=devnet` enforced when `DEMO_CUSTODIAL_WALLETS=true`; reject server startup if that setting appears with mainnet. `DEMO_CUSTODIAL_WALLETS` defaults false unless explicitly enabled for local/demo. Rate-limit demo funding and payment creation. Clearly label all balances `tUSD — devnet test token / no real value`.
- Provide `scripts/setup-devnet.ts` to create/reuse a stable local token mint, six decimals, and treasury-owned mint authority; persist mint public key in `.env` or a config file without leaking the treasury signing secret. Programmatically mint funded test tokens only on devnet. Avoid reliance on rate-limited public USDC faucets; do not call custom tUSD real USDC.
- Lazy-provision encrypted per-user **devnet-only** test wallets only when a participant opts for the Solana demo, not for every discovered chat phone number. Record token mint, address and encrypted secret in a separate `demo_wallets` table. Use AES-GCM with randomly generated IV and env-provided encryption key. Never return signing secrets to the browser.
- Sponsor SOL fees from the treasury as fee payer where the built transaction supports it, while test-wallet owners sign the token transfer in the controlled devnet demo. If ATA setup needs SOL and treasury can pay, create and fund it safely. Derive recipient token accounts using official SPL token helpers.
- `cents * 10_000n` converts USD cents to 6-decimal tUSD base units exactly. No floats, no arbitrary user-entered mint/address. Require recipient's actual mapped demo wallet, expected mint, and amount match intent before signing. Limit per-transfer amount; do not send actual mainnet value.
- Unique `payment_attempt_id` and approval token; `pending -> authorized -> submitting -> submitted -> onchain_verified` with reconciliation. Deal with RPC uncertainty: if signature may exist, check it before ever resubmitting, and never issue two paid transfers for one intent. Persist before network operations; prevent concurrent execution through DB status transition/lock. On confirmation failure, do not credit the ledger.
- Validate on-chain success and token movement with the RPC, including wrong mint, wrong destination, wrong amount, failed transactions, duplicate tx signature, and absence of required confirmation/finality. Display a genuine Solana Explorer **devnet** transaction link.
- If wallet/SDK supports reliable devnet custom-token Solana Pay URLs, optionally expose an external-wallet Solana Pay request; otherwise prefer the functioning direct devnet SPL transfer over a broken wallet deep link. Make future production mode use noncustodial wallet authorization and genuine USDC with separate mainnet review; do not enable mainnet automatically.
- If no Solana RPC/funds/config are available, render `Solana demo unavailable` and offer a **clearly marked simulated scenario for UI tests**, never show it as real on-chain verification.

## 7. Manual rail UX and screenshot/transaction parsing

**Venmo**
- Recipient may save their verified-by-recipient Venmo handle and optional official personal QR.
- UI: exact amount, recipient identity/handle, copy note, optionally open an official profile link only if validated. Do not rely on undocumented transfer-prefill URL formats.
- User completes payment in Venmo, returns to Tab, taps `I paid`, optionally submits transaction screenshot. State is `sender_claimed`, not verified. Recipient gets a private confirmation request; only recipient confirmation changes balances.

**Apple Cash**
- UI: exact recipient identity and amount; tell user to open Apple Cash in the existing Messages conversation or Wallet and authorize payment themselves. This is *not* Apple Pay checkout. Use no guessed Apple Cash deep links and no claims of backend send/verification.
- `I paid` + recipient acknowledgment flow; optional image evidence. Do not parse other private Wallet data without permission.

**Zelle**
- UI: only recipient-supplied Zelle-enrolled email/phone/verified contact hint; open user's own bank app manually; instruct payer to double-check recipient. Don't store banking login credentials or claim a universal Zelle API.
- Same claim/recipient acknowledgment flow.

**Cash/other**
- Record a proposed cash payment and recipient confirmation. Add method as a manual adapter; ledger does not change.

**Receipts and payment records**
- Use one image classifier to distinguish `expense_receipt`, `payment_screenshot`, `invoice_or_bill`, `unrelated`, and `uncertain`.
- A restaurant receipt is evidence of a purchase, not proof of payer. A Venmo/Zelle/Apple Cash screenshot is evidence of an alleged settlement, not confirmation from provider. OCR should extract plausible fields (`platform`, `amount`, `sender`, `recipient`, `timestamp`, `displayed_status`, `memo`, `reference`, `confidence`, `ambiguities`) and propose a link to a specific outstanding intent. Never infer `verified` from OCR; use independent recipient acknowledgment unless there is a documented, authorized provider verification API later.
- Gemini structured response (current SDK syntax) -> Zod parse -> monetary normalization -> participant resolution -> duplicate detection -> **explicit human confirmation**.
- Do not assume `photo sender == person who paid`. Distinguish currency from numeric text. Handle blurry photos, subtotal vs total, taxes/tips, OCR mismatch, refunds and multiple receipts. Ask only the minimal necessary follow-up.
- For privacy/cost, perform cheap local classification and explicit `@tab` command matching first; don't upload every group photo or 20-message transcript to Gemini. If ambient expense detection is enabled, disclose it and keep only a small relevant context window. Use mocks and fixtures for API-free testing.
- Private attachment storage with MIME/size validation, request authorization, retention/cleanup policy and safe redaction; screenshots may contain sensitive data. Never put receipts, payment details, phone numbers, or debt amounts in public link preview metadata.

## 8. Chat commands, state machine, and permissions

Minimum commands:
- `@tab help`, `@tab create trip <name>`, `@tab add expense <description> <amount> [split details]`
- Natural language `@tab I paid $80 gas, split between Amy, Ben, and me`.
- `@tab balances`, `@tab settle`, `@tab expenses`, `@tab confirm <expense-short-id>`, `@tab reject <id>`, `@tab change <id> ...`.
- An attachment with `@tab split this` invokes the vision pipeline.
- Prefer DM/private messages for individual debts and payment receipts; group posts should not reveal addresses, phone numbers, private receipts, or detailed payment proofs.
- Reminder jobs opt-out and backoff; don't spam hourly forever. Keep reminders optional for the 24h MVP.

Critical:
- An expense confirmation must be linked to a specific expense ID and authorized actor. `YES` with no context does not finalize multiple pending expenses. Use reactions only after verified SDK support and reliable mapping to the specific message.
- Check group membership on every group API request; ownership on every payment destination and self-service action; only intended payer can authorize their payment; only recipient can acknowledge receipt. No unauthenticated `GET /groups/:id` with private financial info.
- Simplest privacy-preserving web authentication: single-use, expiring challenge delivered to the platform identity's verified DM, then an HttpOnly secure session cookie; protect mutations with CSRF defenses as applicable and same-site policy. If DM isn't supported, fail closed for real sensitive actions; a clearly labeled seeded demo login is allowed only under `DEMO_MODE`. Never use a guessable `/<group>/<user>` URL as sole authentication.
- Payment intentions need per-request expiry, exact amount/recipient, an unguessable token, idempotency, explicit user confirmation and state locking. HMAC-signed links are useful but not a substitute for authenticating the actor when funds or personal data are at stake.

## 9. Required API surface (names may adapt; contracts must persist)

```
GET    /health
POST   /api/dev/simulate-message              [DEMO_MODE only]
POST   /api/dev/simulate-receipt               [DEMO_MODE only]
POST   /api/auth/start
POST   /api/auth/verify
POST   /api/auth/logout
GET    /api/me
GET    /api/groups
GET    /api/groups/:groupId
GET    /api/groups/:groupId/expenses
POST   /api/groups/:groupId/expenses/propose
POST   /api/expenses/:expenseId/confirm
POST   /api/expenses/:expenseId/reject
GET    /api/groups/:groupId/balances
POST   /api/groups/:groupId/settlements/plan
GET    /api/settlements/:intentId
POST   /api/settlements/:intentId/choose-method
GET    /api/settlements/:intentId/instructions
POST   /api/payment-attempts/:attemptId/authorize-solana
POST   /api/payment-attempts/:attemptId/claim-paid
POST   /api/payment-attempts/:attemptId/confirm-received
POST   /api/payment-attempts/:attemptId/dispute
GET    /api/payment-attempts/:attemptId/status
GET    /api/payments/methods
GET    /api/me/destinations
PUT    /api/me/destinations/:method
POST   /api/receipts/upload
```

All routes: Zod validate incoming data; typed JSON envelopes; meaningful error codes, ownership enforcement and idempotency for mutating money-related operations. `GET /health` must not leak secret configuration.

## 10. Web UX — compact, polished, practical

Mobile-first pages/components:
1. **Trip overview**: group name, participant chips, total expenses, own net balance, linked expenses.
2. **Expense proposal**: merchant, items, total, payer, participant shares, missing info warning, Confirm/Edit/Reject.
3. **Settle up**: who owes whom, precise amount, method-picker with Solana, Venmo, Apple Cash, Zelle, Cash; rails show capability and limitations.
4. **Payment view**: selected payee, amount, recipient details, exact status; Solana `Authorize test payment` only in authenticated demo mode; manual `Copy recipient`, `I've paid`, optional screenshot upload; awaiting recipient confirmation. No pretend universal one-tap transfer.
5. **Recipient confirmation**: `Alex says they paid $30 by Venmo. Did you receive it?` [Confirm] [Not received]. Only authentic recipient sees this.
6. **Activity timeline**: `Proposed`, `Expense confirmed`, `Payment claimed`, `Recipient confirmed`, `Verified on Solana`, including method-specific provenance.
7. **Demo control panel**: seeded users/fixtures, simulated incoming chats, screenshots, reset scenario, Solana connection status; visibly marked DEMO.

Use accessible layouts, clear loading/error/success states, honest status badges, no misleading fake payment success. Open Graph link previews generic, with no private debt amount. Don't require native iMessage extension.

## 11. Tests and acceptance criteria — implement them, not just mention them

Unit tests:
- Deterministic even split with remainder, subset, custom weights/shares, payer included/excluded, invalid/zero/negative cases.
- Four-person $120 grocery example: payer +$90, each other participant -$30, total zero.
- Debt reduction after a $30 outgoing payment from debtor to creditor; two different provider methods produce identical accounting effects after proper confirmation.
- Greedy matching returns a feasible settlement plan, no negative transfer, and conserves value. **Do not claim greedy always finds globally minimum number of transfers**.
- Payment state machine rejects sender self-confirmation, invalid transitions, a second confirmation on the same transfer, attempts above remaining balance, duplicate TX signatures, and mismatched actor/amount.
- Message idempotency and same-image digest duplicate detection.
- Gemini extractor Zod rejects hallucinated/invalid member ID, inconsistent receipt totals, ambiguous payer, unsupported currency, forged screenshot-as-proof.
- Solana unit verification rejects wrong mint, wrong destination, wrong amount, failed tx, duplicate signature. Use mocked RPC fixtures for offline checks.

Integration tests:
- Chat message -> proposal -> payer confirmation -> expense shares -> balances.
- Image fixture -> parser -> review -> confirm -> ledger.
- Create settlement plan -> choose manual rail -> sender claims -> ledger unchanged -> recipient confirms -> ledger updated ONCE.
- Create settlement plan -> choose Solana -> explicit auth -> devnet or mocked chain verification -> ledger updated ONCE.
- Replay Photon event, double-click pay, stale plan, simultaneous attempt and two users claiming same invoice do not corrupt accounting.
- A user cannot view another group's private receipts or verify payments on behalf of someone else.
- `bun run typecheck`, `bun test`, `bun run lint` (if configured), and web build succeed. Provide at least one fixture-driven full walkthrough when no API credentials exist.

Live integrations:
- If Photon credentials exist: actually receive and respond to an iMessage group event and image if supported; document limitations and provide mock fallback.
- If Gemini key exists: actually parse a sample receipt; fallback works otherwise.
- If valid Solana devnet setup exists: mint/reuse tUSD, transfer between distinct demo wallets, verify chain event, show correct explorer URL and ledger update. Do not claim live success if not executed.

## 12. Implementation order and fail-safe progression (24-hour priority)

**Phase 0 / H0–2: Discovery + spikes.** Inspect workspace and package managers. Identify current SDK versions. Verify minimal Photon message loop, attachments/DM/reaction capabilities where credentials permit. Verify a minimal devnet token transaction or script. Document verified vs unknown SDK capabilities in `docs/ADR.md`. Initialize project and `.env.example`.

**Phase 1 / H2–8: Reliable accounting spine.** Define DB schema/migrations. Build pure integer-cent split, balance, settlement and idempotency services; group identity mapping; message simulator; unit tests. Achieve first text-based expense -> confirm -> correct balances with no AI credentials.

**Phase 2 / H8–13: AI + chat.** Implement Photon adapter, command router and explicit receipt upload; Gemini structured output and fallback fixtures; pending expense confirmation. Run full mock/real messaging test.

**Phase 3 / H13–18: Multi-rail payment architecture and Solana.** Implement rail registry, manual methods + recipient confirmation, intents and authenticated actions; then true Solana devnet custom tUSD transfers/verification, reconciliation, explorer link. Test duplicate requests and RPC failure recovery. **This is the main blockchain demo.**

**Phase 4 / H18–21: Mobile UX.** Integrate payment rail picker, instructions, manual claim/confirm, Solana devnet test payment, status page, generic link previews. Polish mobile demo.

**Phase 5 / H21–24: End-to-end hardening.** Run all checks, fix bugs, test phone behavior, record a deterministic seeded demo; write README/setup/troubleshooting. Defer itemized splits, recurring bills, clubs, native iMessage extension, bank connectors, production custody and real mainnet token settlement unless essential flow is complete.

If time is tight, the **non-negotiable vertical slice** is: mock or live group chat -> confirmed text expense -> ledger -> method picker -> actual Solana devnet verification OR independently recipient-confirmed manual payment -> correct balances. Never sacrifice this to build cosmetic stretch features.

## 13. Deployment, setup, and documentation

- Root commands such as `bun install`, `bun run dev`, `bun run db:migrate`, `bun run seed:demo`, `bun test`, `bun run typecheck`, `bun run build`, and `bun run demo:smoke` should actually work. No undefined scripts.
- `.env.example` documents `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `DATABASE_URL`, `APP_BASE_URL`, `SESSION_SECRET`, `SOLANA_CLUSTER=devnet`, `SOLANA_RPC_URL`, `TAB_TEST_TOKEN_MINT`, `TREASURY_SECRET_KEY` (or protected key path), `WALLET_ENC_KEY`, `DEMO_MODE`, `DEMO_CUSTODIAL_WALLETS`. Validate config once at startup; do not require secrets for the mock path.
- Environment modes clearly separate `mock`, `devnet_demo`, and future production; no implicit mainnet fallback. API keys and private keys never committed.
- README must include architecture diagram, copy/paste startup commands, what features are truly live vs mocked, Photon/iMessage setup, how to seed tUSD, wallet funding and limits, expected demo flow, security warnings, and troubleshooting.
- `docs/ADR.md` should record choices/tradeoffs: Photon instead of building chat, model-assisted extraction vs deterministic ledger, Solana devnet primary vs multiple manual rails, web-first instead of native extension, identity and auth boundary, recipient-confirmed vs chain-verified status, mock fallback, privacy, custody limited to devnet. `docs/PAYMENT_RAILS.md` must say exactly what adding a new provider entails.
- Use reproducible fixtures and deterministic seed data. Preserve existing repository files; do not overwrite user data.

## 14. Execution instructions for this autonomous coding session

Follow this order **without stopping after planning**:

1. **Audit** the repo and available toolchain; read README and package files. Briefly report findings, then proceed.
2. **Draft internally and save** `docs/ARCHITECTURE.md`, `docs/ADR.md`, and `docs/IMPLEMENTATION_PLAN.md`, refining them twice for: (a) hard product constraints and minimal onboarding; (b) correctness, threat model, payment-provider limits, actual 24h scope. Your final implementation must follow the refined ADR, not the first draft.
3. **Implement vertical slices directly in code**, preferring smallest working implementations to placeholders: database/domain -> simulator -> messaging/AI -> provider abstraction -> manual confirmation -> Solana devnet -> web.
4. **Test and fix continuously**. Use available installed packages and current official documentation; check the exact method signatures. If SDK methods aren't supported, document it and fall back honestly.
5. **Demonstrate** the four-friend case with exact balances, a real Solana devnet transaction if environment permits, and a manual Venmo/Apple Cash/Zelle payment confirmed by the recipient. In no-credentials mode, provide an honest simulated full walkthrough.
6. **At completion**, output (i) file tree and major architectural decisions, (ii) exact commands to run, (iii) test/build results and what you personally executed, (iv) which integrations are live/mock/unavailable, (v) any environment variables/credentials I must supply, (vi) security and production-readiness caveats, and (vii) the recommended next three highest-value improvements.

**Acceptance bar:** A developer can clone/open this repo, install dependencies, run a local demo without external accounts, understand how Solana and manual settlement differ, and—after filling credentials—run a real iMessage + Gemini + Solana devnet end-to-end flow. All payment methods share ONE accounting engine; no screenshots or text messages are falsely marked as independently verified payments. Now inspect the repository and begin implementing.
