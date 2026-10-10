# Tab: Project Plan

> An AI agent you text to split shared costs. Send it receipts and "paid $80 for gas," and it tracks the group's balances, gets everyone's OK, reminds people who haven't paid, and lets them settle up with **Apple Pay** or **USDC on Solana**.
>
> Built for **HackNC 2026** with **Photon Spectrum** (iMessage), **Google Gemini** (understanding messages and receipts), **Solana** (crypto payments), and **Stripe** (Apple Pay + payouts).
>
> Technical details are in [ARCHITECTURE.md](./ARCHITECTURE.md). Build status is in [PROGRESS.md](./PROGRESS.md).

## Problem
Group trips, roommates, dinners, and clubs all produce scattered costs. Someone books the Airbnb, someone else covers gas, receipts pile up, and nobody remembers who owes whom. Splitting apps need everyone to download an app and type every expense in by hand. People already live in iMessage, so tracking should happen there.

## Solution
Each person texts **Tab** directly (1:1 iMessage). Behind the scenes, Tab groups people into a shared **group**, like "Tahoe Trip." It:
1. **Collects.** Members text the bot receipt photos, screenshots, or "paid $80 for gas, split with everyone." Gemini pulls out the amount, payer, and who's included.
2. **Keeps a running tab.** Each affected person gets a heads-up with their share and running total. It counts right away. If something's off, they reply **NOPE** and that share goes on hold.
3. **Tracks.** It keeps the group ledger: who owes whom, netted between each pair of people so every dollar traces back to a real expense.
4. **Explains.** Anyone can text *"what are my expenses?"* and get their tab as a **rich card in iMessage** (running total, who owes whom), which opens a full "Your Tab" page. *"Why do I owe this?"* gives the original message, the receipt, and the math.
5. **Settles.** Each debtor gets a DM with two ways to pay: reply `PAY` (USDC from their Tab wallet on Solana) or tap a link to **pay with Apple Pay**.
6. **Reminds.** It nudges people about unpaid balances and shares they haven't reviewed.

The **native iMessage extension** is how Tab appears in the *real* group chat. Members can drop interactive cards like "New expense: Gas $80 · Approve" or "Tahoe Trip · settle up" into the chat, and open balances, approvals, and Pay without leaving Messages.

## Key decisions
| Topic | Decision |
|---|---|
| Messaging | **Photon Spectrum cloud, 1:1 DMs only.** Our subscription doesn't include group chats, so the bot never sits in a group thread. Groups live on our server. |
| Joining a group | The organizer texts "new trip Tahoe." The bot replies with a join code and a one-tap link (`sms:<bot>&body=JOIN TAHOE42`) to paste into the real group chat. Members text `JOIN TAHOE42`. |
| Expense input | Members DM receipts, screenshots, or text. **In one trip:** just the amount and description. **In several trips:** Tab asks "Which trip is this for? 1) … 2) …" unless the message names one ("#asheville", "for the asheville trip", "apartment: …"). The organizer can **END TRIP** so finished trips stop counting. |
| Payments | **Two ways to pay, one ledger.** **Solana:** USDC from wallets the backend makes for each user (devnet). **Apple Pay:** Stripe (test mode) on our web pay page, with payouts to the creditor in **dollars via Stripe Connect**. |
| Apple Pay placement | **Web** (Stripe Express Checkout on the pay page). No paid Apple Developer account needed. The extension's Pay button opens that page. |
| Creditor payouts | Creditors who want card or Apple Pay payments connect Stripe once (onboarding link sent by DM). Money paid before they connect is **held** and transferred once they do. |
| UI | **Native iMessage extension** (Swift/SwiftUI) as the in-group-chat experience. A rich link preview plus the mobile pay page covers everyone else. |
| Running tab | **Expenses count as soon as they're logged.** Everyone gets a heads-up with their share and running total. Nothing to approve. Anyone can reply **NOPE + what's off** to put their share on hold (no "dispute" wording). |
| Your tab | Text **"what are my expenses"** / SUMMARY / "my tab" → short text + a **rich link card** (Partiful-style preview image) that opens a Frutiger Aero "Your Tab" page with every expense, your share, and who owes whom. |
| Netting | When two people owe each other, **only the difference is paid** ($20 one way, $25 the other → one $5 payment). The summary shows the subtraction. |
| When to pay | **Only when someone texts SETTLE.** No payment requests or reminders mid-trip. Reminders start only after a SETTLE. |
| Receipts | **Optional but marked.** Text-only expenses need a stated reason and get a "no receipt" badge. |
| Transparency | **"Why do I owe this?"** answers come only from ledger records, never made up. |
| MVP use case | **Trips.** Roommates, restaurants, and clubs are stretch goals on the same model. |

## Core user flows (all in 1:1 DMs)
1. **Create a group:** Amit texts "new trip Tahoe." The bot creates the group and sends a join code plus a ready-to-paste invite for the real group chat.
2. **Join:** Jake taps the invite (or texts `JOIN TAHOE42`). The bot adds him, makes his Solana wallet, funds it with test USDC, and explains how Tab works.
3. **Log an expense:** Amit DMs a receipt photo plus "gas, everyone." The bot confirms to Amit:
   > Logged to Tahoe Trip: Gas $80.00 · split 4 ways ($20 each) · 🧾 receipt matched. I let Jake, Sam and Priya know. Running total: you're owed $60.00.
4. **Heads-up:** each participant gets the receipt photo, then:
   > Amit logged **Gas $80.00** (🧾 receipt matched) for Tahoe Trip. Your share: **$20.00** · Running total: you owe $46.66. Not right? Reply NOPE and what's off.
   If someone replies "nope, I didn't ride", their share goes on hold and the payer can reply with a new amount ("make it $60"), OK a suggested amount, REMOVE it, or send the receipt.
5. **Why:** "why do I owe Amit $42?" returns the itemized breakdown with sources.
6. **Settle up:** anyone texts `SETTLE` (or taps it in the extension). The bot works out who owes whom and DMs each debtor:
   > You owe Amit $42.10 for Tahoe Trip. Reply **PAY** to send USDC from your Tab wallet, or **pay with Apple Pay**: tab.app/p/… · Reply WHY for the breakdown.
7. **Pay:**
   - **Solana:** `PAY` sends tUSDC wallet-to-wallet with an explorer link.
   - **Apple Pay:** the link opens the pay page, and Face ID completes it. Stripe sends the money to Amit's connected Stripe account, or holds it until he connects.
   - Debtor and creditor both get "✅ Jake paid Amit $42.10 (Apple Pay)."
8. **Remind:** scheduled DMs for unpaid balances and unreviewed shares. Optional daily digest per group.

## Payment options
| | Solana (USDC) | Apple Pay (Stripe) |
|---|---|---|
| Debtor experience | Reply `PAY` in DM, or tap Pay → Solana in the extension | Tap link → pay page → Face ID |
| Debtor needs | Nothing (we make the wallet and fund it on devnet) | Card in Apple Wallet, Safari on iPhone |
| Creditor receives | tUSDC in their Tab wallet | USD in their Stripe Connect account (bank/debit card) |
| Creditor setup | None | One-time Stripe Connect onboarding (link via DM) |
| Confirmation | On-chain signature, explorer link | Stripe webhook `payment_intent.succeeded` |
| Hackathon mode | Devnet, our own tUSDC token | Stripe test mode (real Wallet card, not charged) |

Both options settle the **same ledger**. A payment is valid only up to what the debtor currently owes that creditor (flagged shares excluded).

## Trust & anti-abuse
- **A reason is required.** "Pay me $20" with no reason isn't recorded, and the bot asks what it was for.
- **Everyone sees every charge.** Each person gets a heads-up (with the receipt photo) for every expense they're in. Only *you* can flag *your* share, and a flagged share stops counting until it's fixed.
- **Receipt checks.** Gemini reads the receipt total. If the claimed amount is off by more than $1 or 5%, the expense gets an `amount_mismatch` flag.
- **Duplicate detection.** A matching image hash, or the same merchant + total + date, gets a `possible_duplicate` flag.
- **Receipt badge.** Text-only expenses are labeled ⚠️ no receipt.
- **Flags (NOPE).** The payer fixes the amount, takes the suggested one, removes it, or adds a receipt. Everyone gets a fresh heads-up.
- **Audit trail.** Every create, edit, flag, and payment is logged and shown in the "why" view.
- **Payments are capped.** Amounts can't exceed what's owed. A payment only counts as paid after the chain confirms it or Stripe's webhook arrives, never from the browser saying so.

Known limit: someone with a real receipt for something unrelated can still try it. Per-person approval and full visibility make that easy to catch.

## Team split
| Person | Owns |
|---|---|
| A | Spectrum DM bot: messaging wrapper, group create/join, active group, handler, outgoing DMs to each person, reminders/digest |
| B | Gemini extractors + explain, ledger (splits, settle, validate, approvals), database |
| C | Payments: Solana wallets/transfers, Stripe (Apple Pay pay page, Connect onboarding, webhooks, held transfers) |
| D | Swift iMessage extension (login, balances, approvals, why, Pay, group-chat cards) + link-preview images |

## Timeline (~24h)
| Hours | Goal |
|---|---|
| **0–2** | **Spike:** confirm Spectrum DMs: receive, send, image attachments, sender phone number, whether the bot can text someone first, rate limits. Stripe test account with Connect + Apple Pay domain registered on the **deployed HTTPS URL**. tUSDC mint + treasury. Xcode project running on a phone. |
| **2–10** | Create/join by code, text expense via DM, approval DMs to each person, ledger, `SETTLE`, `PAY` via Solana, end to end. Reject expenses with no reason. |
| **10–16** | Receipts/screenshots via Gemini vision + checks, WHY, disputes, **Apple Pay pay page + Connect onboarding + webhook + held transfers**, extension login + balances. |
| **16–20** | Extension group-chat cards + approvals + add expense, reminders/digest, link previews, polish. |
| **20–24** | Stretch goals, demo script, demo video. |

## Stretch goals
- **Restaurants:** line items, tap to claim yours, tax and tip split in proportion.
- **Roommates:** recurring bills created monthly, automatic reminders.
- **Clubs / events:** fixed dues per member, "who hasn't paid" view.
- **Apple Pay → USDC:** send Apple Pay money to the creditor's Solana wallet through a crypto on-ramp (Coinbase/Stripe) when they prefer USDC.
- **Native Apple Pay in the extension** (PassKit) if we get a paid Apple Developer account.
- **Bot in the group chat** if the Photon plan ever includes group chats.

## Verification
- **Unit tests** (`npm test` in `server/`):
  - Splits: cent rounding always adds up exactly.
  - Settle: debts net correctly in both directions, payments reduce them, and balances add to zero.
  - Approvals: someone else's approval is ignored, auto-approval only with a receipt, edits reset shares, disputed shares are left out.
  - Validation: amount-mismatch and duplicate flags.
  - Payments: amount cap, held Stripe transfer released after Connect onboarding.
- **Gemini fixtures:** receipts, chat screenshots, and texts. Check totals, participant mapping, and `has_reason=false` for "pay me $20".
- **Solana script:** create 2 users, fund, transfer, check the devnet explorer link.
- **Stripe:**
  - `stripe listen --forward-to <url>/stripe/webhook` and `stripe trigger payment_intent.succeeded` to check webhook handling.
  - Full Apple Pay flow on a real iPhone in Safari (test mode), then check the transfer in the Connect test account.
- **End-to-end demo** (3 phones, each texting the bot):
  1. Amit creates a group and pastes the invite into the real group chat. Jake and Priya join.
  2. "pay me $20" makes the bot ask why. A receipt for gas plus "everyone" gets logged, and each person approves in their DM. Priya disputes a second expense.
  3. `SETTLE`, then Jake pays via `PAY` (Solana) and Priya via **Apple Pay**, before Amit has connected Stripe, so it's held. Amit connects Stripe and the held transfer is released.
  4. A card from the extension is posted in the group chat and shows updated balances.

## Risks
| Risk | Mitigation |
|---|---|
| No group chats on our Photon plan | Groups are server-side, members join by code, and everything happens in 1:1 DMs. The extension covers the group chat itself. |
| The bot can't text someone first | Joining is always initiated by the member (`JOIN CODE` / one-tap `sms:` link). |
| Spectrum rate limits when messaging each person | Approvals batched per person. A digest replaces a stream of updates. Demo mode keeps groups small. |
| Apple Pay web needs a verified HTTPS domain | Deploy early (Railway/Fly) and register the domain with Stripe in the spike. No changing ngrok URLs. |
| Creditor hasn't onboarded to Stripe | Charge goes to our account and is held, then transferred automatically after onboarding. The bot nudges the creditor. |
| Gemini misreads who's included | Everyone gets a heads-up and can reply NOPE; the share stops counting until fixed. |
| Fake or inflated expenses | Required reason, receipt check, duplicate detection, a heads-up to every person, NOPE flags, audit trail. |
| Backend holding wallet keys | Devnet only. Mainnet would need an embedded-wallet provider (Privy/Crossmint/Turnkey). |
