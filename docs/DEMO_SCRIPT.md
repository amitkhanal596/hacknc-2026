> Current onboarding uses private DMs and shared invitations. Follow [the current DM demo guide](DIRECT_MESSAGE_DEMO.md) first. The payment scenarios below still apply. The UI tab formerly called Group chat is now Tab messages.

# Complete four-friend demonstration

Start with `bun install`, `bun run db:migrate`, `bun run seed:demo`, and `bun run dev`. Open http://localhost:5173. Everything on the local demo identity switcher is labeled simulation. Real provider credentials are optional for the accounting demonstration.

1. Explore as Alex. Click **Try the $120 grocery example** (or send `@tab I paid $120 for groceries, split with everyone` under Tab messages).
2. In Overview, review four $30 shares and confirm the specifically identified proposal as Alex. Balances: Alex +$90; Ben, Casey and Drew −$30 each. No wallets exist.
3. As Alex, save recipient-owned Venmo and Apple Cash or Zelle details in Payment details. For a purely local demo, use a clearly fictional handle and `alex@example.test`; never pay those fixture details in a real provider app. Cash needs no setup.
4. Click Calculate settlements. Repeating this returns the same reserved plan.
5. With devnet setup complete, Alex and Ben each opt into test wallets in Payment details. As Ben choose Solana, review exact $30 tUSD, then explicitly authorize the test payment. Wait for **On-chain verified · devnet** and open the actual explorer link. This is a fake custom token with no monetary value. Without devnet setup, Solana is unavailable: the preview is labeled and does not credit the ledger. Use cash with recipient confirmation to complete the browser demo, or run `bun run demo:smoke` for the offline RPC fixture workflow.
6. As Casey, choose Venmo. Check Alex’s supplied handle and amount; complete payment independently only when intentionally demonstrating a real manual payment. In local simulation simply claim the fictional transfer. Click **I’ve paid**. Casey still owes $30. Switch to Alex, open the incoming request, check the actual provider account when applicable, and confirm receipt. Casey now has zero balance. The badge says **Confirmed by recipient**, never provider-verified.
7. As Drew, repeat with Apple Cash, Zelle or cash. Only Alex’s independent confirmation reduces Drew’s debt.
8. All four balances are zero. Activity preserves distinct confirmation provenance. Group updates show resolved settlement counts without handles or private evidence.

For receipt parsing, start a fresh scenario before settling: Tab messages → Simulate dinner receipt. The fixture totals $84 ($70 subtotal + $5.60 tax + $8.40 tip). Select who paid before confirmation. The image sender is not assumed to be payer. Simulate payment screenshot to see evidence classification with no expense or credit.

## Commands exercised by the automated demo

`bun run demo:smoke` creates an isolated in-memory database, separate authenticated demo sessions, one Solana RPC fixture and two manual rails, asserts claims do not change balances, rejects sender self-confirmation, and checks exact zero balances. It prints **OFFLINE SIMULATION**. No live devnet claim is made by this script.

`bun run demo:devnet` is an explicitly invoked devnet-only CLI demonstration, with exact $30 approval via the trusted local CLI actor. It creates a fresh demo group, enables Alex/Ben test wallets, executes and verifies the real devnet transaction, then simulates the two manual confirmations. It prints a live explorer link only after actual verification. It never claims actual Venmo/Apple Cash money movement.
