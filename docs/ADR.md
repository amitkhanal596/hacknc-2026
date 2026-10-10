# Architecture decisions

1. Bun + Hono + SQLite/Drizzle + React/Vite follows the specification. SQLite needs a persistent volume and a single server instance. No hosting migration in this MVP.
2. Domain arithmetic uses safe integer cents and BigInt weighted division. Provider-independent credits are applied atomically. Greedy netting is feasible and deterministic, not globally minimal.
3. Gemini only produces proposals. Explicit payer/owner confirmation is mandatory. Currency USD only; ambiguous receipts require payer selection. Mock parsing is deliberately constrained and labeled.
4. Photon replaces custom chat infrastructure. SDK source/types will be checked during implementation. Live delivery, account provisioning and image behavior require credentials and cannot be asserted from compilation.
5. Recipient-confirmed manual rails share one adapter. Destination ownership is self-attested, not provider verification. No payment screenshots imply settlement. No undocumented deep links.
6. Solana devnet custom six-decimal TAB Test USD is the primary executable rail. No mainnet mode, genuine USDC, production custody or external-wallet claims. Test-wallet keys use AES-256-GCM. Sponsor fees with the treasury.
7. Web-first authentication separates verified messaging identity from payment approval. Real login uses a single-use token in a provider DM; missing DM delivery fails closed. Loopback-only demo login is a local testing capability, never production authentication.
8. Refinement one: minimum onboarding; create chat users on observed authenticated provider events, not fabricated phone-derived identities. Payment setup is lazy. Manual methods do not require a wallet.
9. Refinement two: reject partial payments; lock outstanding plans against expense confirmation; persist signed transactions before network submission; never generate a replacement for uncertain broadcasts. Cancel only untouched or definitively failed attempts. Freeze disputed attempts pending human review. Append audit events; confirmed expenses cannot be edited.
10. Scope: item claims, scheduled reminders, production deployment, external wallets, refunds and provider-verified manual payments are deferred. Reminder preferences exist but no automatic spam.

## Sources and capability evidence

- Photon official SDK: https://github.com/photon-hq/spectrum-ts (installed package types are the implementation contract).
- Gemini structured outputs: https://ai.google.dev/gemini-api/docs/structured-output
- Solana checked transfers: https://solana.com/docs/tokens/basics/transfer-tokens

Actual package versions, SDK observations and live execution results are recorded after the spikes and final checks.

## SDK spike observations

The published Spectrum 12.10.1 declarations were read directly. They expose `Spectrum({projectId, projectSecret, providers})`, an async `[Space, Message]` stream, `direction`, `sender.id`, `content`, group-content items, `space.send`, `space.getMembers`, `imessage(spectrum).space.create/get`, and attachment `stream()`. The implementation disables telemetry, ignores native groups; processes voluntary DMs and reads image bytes only after an active-tab membership check, and bounds streams to 4 MB. DMs use a one-person private space derived solely from the provider-observed identity. Runtime support still depends on the provisioned Photon account; it is not claimed as live-tested.

Real images with no Gemini key fail visibly and can be entered manually; the receipt/screenshot buttons invoke explicit fixtures. No default current model name is guessed. The configured model must support the installed SDK's structured `generateContent` API.

The initial public devnet RPC probe failed TLS validation. Later probes succeeded with TLS checks still enabled and exposed a truncated expected genesis hash, which was corrected against the official devnet response. Setup now recognizes devnet, but the public faucet rejected treasury funding. No mint or transfer was completed. A funded devnet treasury is still needed for the live demonstration.

## iMessage-first clarification

The intended product is a Partiful-like flow entered from iMessage, using Photon. The dashboard is a lightweight companion reached from the conversation, not an account-signup requirement. `@tab create trip` posts a generic trip link; `@tab link` delivers a single-use five-minute private sign-in link via provider DM. The credential is carried in a URL fragment, removed immediately by the browser and submitted over POST, so it does not appear in server URL logs or previews. Opening a link grants a scoped session, never approval to pay. Exact payment approval remains a separate private action. The shared group link alone grants no access.

## Installed and checked versions

Bun 1.4.3; Spectrum 12.10.1; Google GenAI 2.28.0; Solana web3.js 1.99.0 and SPL Token 0.4.15; Drizzle ORM 0.45.4; Hono 4.13.13; React 19.2.6; Vite 6.3.5; TypeScript 6.0.3. Direct runtime dependencies are pinned and `bun.lock` is included as the reproducible package graph. Vite's built-in TSX support is sufficient for the MVP; an incompatible optional React plugin found during the first build was removed. SQLite's conditional `UPDATE … RETURNING` is used for atomic token consumption.

## Shared-plan change (current behavior)

The user requested a Partiful-style invitation + private-DM flow because their Photon plan does not provide the required group features. This supersedes the group-onboarding description above. A tab is a ledger entity independent of any provider space. `create`, `invite`, `join`, `tabs`, `use`, `name`, `STOP` and `START` use deterministic routing; expense parsing alone can call Gemini. Confirmation sends private per-share updates and one-use dashboard links. No native group or membership-discovery APIs are used. Existing legacy group data is retained but outbound legacy group delivery is disabled. Shared-plan recipients must be allowlisted in Photon and accept a Tab invitation before getting expense updates.

Invite links grant join permission, expire in seven days, and are revocable; sign-in links are private, single-use, five-minute credentials. Membership and payment approval remain separate. No reminders or new paid Photon services are enabled. See DIRECT_MESSAGE_DEMO.md for exact local/live setup.
