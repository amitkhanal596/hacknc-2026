# Velo 💸

**The friend on your trip who handles the money, over iMessage.**

Velo is an AI agent with a real phone number that everyone on a trip texts over iMessage. Text Velo what you paid, as plain text or as a photo of the receipt. Velo asks who to split it with, then privately tells each friend their share. It reminds people who forget, and settles up on **Solana** when someone texts "pay". There's no app to install and no spreadsheet.

Built at HackNC 2026 for the **Best iMessage Agent with Photon** and **Solana** tracks.

## What it does

- **Log expenses in plain English:** "I paid 120 for gas, split 4 ways" or "Airbnb was 640, everyone but Sam".
- **Read receipts:** snap a photo and Velo lists the items, then asks "who had what?". Tax and tip are split in proportion to what each person ordered.
- **Trips:** "start trip Asheville with Sam, Jo, Ryan" invites friends. Each one replies JOIN.
- **Shares to everyone involved:** every logged expense is sent as a personal DM to each person in it ("Your share: $27.15").
- **Show who owes whom:** text "settle" and each person gets the fewest payments needed to clear everyone's debts.
- **Send polite reminders:** Velo privately texts anyone who hasn't paid yet.
- **Pay over iMessage:** reply PAY, then YES. Velo sends the money on Solana devnet and texts both people the transaction link.
- **Trip page:** a read-only web page showing the whole trip: every expense, balance and on-chain transaction.

## How it works

```
Each friend ⇄ 1:1 iMessage ⇄ Photon Spectrum → Velo service (TypeScript)
                                              ├─ Gemini: reads receipts, understands messages
                                              ├─ Ledger: integer-cent split & settle math (SQLite)
                                              └─ Solana devnet: per-member wallets, vUSD transfers
```

| Layer | Tech |
|---|---|
| Messaging | Photon Spectrum (`spectrum-ts`, cloud iMessage) |
| AI | Google Gemini (vision + function calling) |
| Payments | Solana devnet, `@solana/web3.js`, `@solana/spl-token` (test token "vUSD") |
| Backend | TypeScript (Bun/Node), SQLite, node-cron, Hono |

Full design and trade-offs: [`docs/adr/0001-velo-architecture.md`](docs/adr/0001-velo-architecture.md).

> ℹ️ On Spectrum Pro, Velo works through 1:1 chats (a "virtual group"). With a dedicated Photon line, the same logic runs inside a real iMessage group chat.

> ⚠️ **Demo only.** Velo holds a devnet wallet for each member so payments take one tap. A production version would use embedded/MPC wallets so Velo never holds a raw private key.

## Running locally

_Coming soon, once the service is scaffolded._ Required environment variables:

```
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=
GEMINI_API_KEY=
SOLANA_RPC_URL=https://api.devnet.solana.com
VELO_TREASURY_SECRET=    # base58 secret of the fee-payer / mint authority wallet
VELO_MASTER_KEY=         # 32-byte hex key used to encrypt member wallets
DEMO_MODE=1              # fast reminder schedule for demos
```

## Team

- **A:** messaging & agent loop
- **B:** AI (receipts + intent)
- **C:** ledger, Solana & ledger page
