# Implementation phases

0. Read entire spec, inspect empty repository/toolchain, install Bun and SDKs, inspect their types, save architecture and two explicit refinements.
1. Schema, migrations, pure integer arithmetic, ledger, proposals, seed and integration tests.
2. Message idempotency, fixture parser, Gemini schema adapter, Photon event adapter, private assets and session authentication.
3. Intent reservation, method registry, manual receipt confirmation, exact single-use authorization, encrypted wallets, stable mint setup, durable devnet transfer and reconciliation.
4. Mobile dashboard, proposal review, payment picker, recipient inbox, activity and clearly labeled demo controls.
5. Typecheck, tests, build, credential-free end-to-end smoke, attempt devnet setup, document actual evidence and limitations.

Product refinement: prioritize zero-wallet group entry and complete mixed-payment workflow.
Security refinement: payment approval is separate from chat; financial state transitions are atomic and audited; ambiguous network outcomes remain unresolved until reconciliation.

6. Shared-plan revision: logical tabs, invitation acceptance, per-user active context, private DM updates and private browser links; migration and recipient-filtered outbox; desktop/mobile invitation tests and updated credential checklist.
