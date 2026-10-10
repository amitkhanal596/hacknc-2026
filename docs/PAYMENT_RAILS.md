# One ledger, multiple settlement methods

| Method | Tab execution | Settlement authority | Wallet required |
| --- | --- | --- | --- |
| Solana devnet | Signed checked SPL token transfer | Finalized RPC transaction, exact mint/accounts/amount/reference and token deltas | Both parties explicitly enable test wallets |
| Venmo | None; recipient-supplied handle and instructions | Authenticated recipient after sender claim | No |
| Apple Cash | None; Messages/Wallet instructions | Authenticated recipient after sender claim | No |
| Zelle | None; participating bank app instructions | Authenticated recipient after sender claim | No |
| Cash | None; hand cash to recipient | Authenticated recipient after sender claim | No |

`PaymentRail` lives in `server/src/payments/types.ts`. A capability declares whether a provider can execute and how it verifies. A settlement intent is provider independent. Choosing a rail creates a child attempt with an immutable instruction/destination snapshot. At most one nonterminal attempt exists per intent. Partial payments are deliberately rejected: an attempt must equal the full remaining obligation.

To add a provider:

1. Add its method name to the type/validation registry and implement `prepare`.
2. Supply `executeAuthorized` only with a documented supported transfer API. Keep credentials server-side. Persist submission reference before uncertainty is possible.
3. Implement independent verification, including exact amount, currency, payee and unique external reference. A screenshot parser cannot be the verifier.
4. Register its capability in `Payments`. Add its display name/instructions to the web picker.
5. Test wrong actor/amount, claim-only balances, duplicate requests, provider uncertainty, confirmation races and once-only credit. The accounting engine and domain schema need no provider-specific calculation changes.

For manual methods the recipient confirms ownership of their displayed details; this is not verification by Venmo, Apple, or a bank. The MVP uses no guessed payment links, unofficial provider APIs, QR generation, or production money movement.

## Solana recovery

The authorization challenge binds user, attempt, exact amount and recipient for five minutes. Signing happens only after atomic token consumption and a transition to `submitting`. Signed bytes, signature, block-height expiry, mint and expected token movement are committed before broadcast. The reconciler checks the same signature and may rebroadcast identical bytes while valid. It never signs a replacement transaction after uncertain submission. Definitively failed finalized transactions do not get credit. An expired transaction missing from the configured RPC remains unresolved for human investigation; absence from one RPC is insufficient proof that it never landed.

On-chain verification requires finalized success, source-owner signature, a single checked transfer from the expected SPL program, memo reference, six decimal mint, expected source/destination accounts, and exact pre/post token deltas and owners. Unique signatures and unique intent credits prevent double settlement.
