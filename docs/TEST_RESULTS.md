# Execution results

These are commands actually executed in this workspace, not proposed checks.

| Check | Actual result |
| --- | --- |
| `bun install --frozen-lockfile` | Passed; reproducible Bun lockfile, dependencies installed |
| `bun run db:generate` | Passed; initial 19 tables plus DM migration (23 tables total) |
| `bun run db:migrate` | Passed against persistent local SQLite |
| `bun run seed:demo` | Passed; four members, no automatic wallets or invented handles |
| `bun run typecheck` | Passed, strict TypeScript |
| `bun test` | **69 passed, 0 failed; 968 assertions** |
| `bun run format:check` | Passed |
| `bun run build` | Passed; 30 modules, JS ~233 kB (~72 kB gzip), CSS ~20 kB |
| `bun run demo:smoke` | Passed; four simulated private DMs join by invitation, four private $30 notices, mocked RPC Solana + recipient-confirmed Venmo/Apple Cash; four exact zero balances |
| `bun run test:browser` | Passed in installed Chrome; desktop and 390px mobile, separate sender/recipient interactions, no page errors or horizontal overflow |
| `bun run test:browser:dm` | Passed; organizer creates a tab, mobile invitation, separate guest accepts, confirmed split/private share notice and STOP |
| HTTP UI / health | 200 / 200 |
| Unauthenticated private API | 401, as intended |
| `bun run check:photon` | Passed against live Photon: project authentication accepted; shared iMessage token issued; no messages sent by diagnostic |
| Live Photon configuration | Authenticated management requests returned HTTP 200: iMessage enabled, shared account |
| Photon listener startup | SDK initialized successfully; awaiting an inbound `@tab ping` to verify actual delivery |
| `git diff --check` | Passed |
| `bun run setup:devnet` | **Failed** before mint creation or transfer; devnet genesis confirmed; public faucet rejected treasury funding |
| Live Photon message round trip | **Not verified**: no inbound Tab command received during checks |
| Live Gemini | **Passed**: synthetic $120 purchase → expense_text, 12000 cents, two participants, correct payer; model gemini-2.5-flash |
| Live Solana transfer | **Not run successfully**: treasury funding unavailable; no real explorer signature is claimed |

The first validation pass caught and fixed a dev-launcher module typing issue, SQLite token-consumption return typing, an unknown-route JSON mismatch, and an optional Vite React plugin version mismatch. A subsequent live RPC probe also caught and corrected a truncated devnet genesis-hash guard. The final checks above are after those fixes. Solana's optional native bigint acceleration was unavailable; its supported pure JavaScript fallback ran all tests successfully.

## Demonstrated security properties

Integer remainder/weighted/custom shares, conservation across generated settlements, payer-included/excluded balances, no-wallet participation, replay deduplication, receipt total/member validation, screenshot-as-proof rejection, private group/assets, evidence ownership, CSRF, DM-unavailable fail-closed authentication, one-use private login challenges, exact payment approvals, sender self-confirmation rejection, duplicate confirmations/signatures, concurrent attempts/confirmations, active-plan reservation, expiry, disputes, AES-GCM authentication, mainnet rejection, finalized token/mint/account/signer/amount/reference/delta checks, and uncertain-RPC identical-byte rebroadcast.

Screenshot OCR fixtures include a displayed “Completed” status and proposed matching intent. The test proves this produces zero settlement credit without recipient confirmation.

## Browser artifacts

Local screenshots are in `.data/screenshots/overview-desktop.png` and `.data/screenshots/overview-mobile.png`. They were opened and visually reviewed. The browser test creates a new demo scenario rather than deleting existing trip history. These private runtime artifacts are ignored by git.

## What still needs live verification

- Photon credentials now authenticate successfully and iMessage is enabled. Still unverified: actual ping response, individual update delivery, private sign-in links and receipt attachment delivery. The revised implementation does not use native groups. Shared-mode participants must be registered in Photon's Users tab. Browser links currently point to localhost and require a reachable HTTPS deployment for phone use.
- Gemini external key and model now work for live structured text extraction. Actual receipt image OCR remains to be verified.
- A trusted/reachable devnet RPC, funded devnet treasury, created six-decimal mint, and configured AES-GCM key: an actual finalized tUSD transfer. An initial TLS probe failed, but subsequent RPC probes succeeded with certificate validation enabled. The final setup blocker is public faucet funding.

The offline RPC fixture is used only by test/demo code with isolated storage; the server never registers it as a payment rail. Its output is explicitly labeled simulation. Manual provider transfers in the fixture walkthrough are also simulated; only the application’s claim/recipient-confirmation workflow is exercised.

Final public RPC evidence: `getGenesisHash` returned `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`; the generated treasury has **0 lamports**. The airdrop request returned **HTTP 429 Too Many Requests**, with the faucet reporting an airdrop limit or exhausted supply. Fund devnet public address `sW7wNwZiKFTbnFeg3e1omM5fDGGQ8VZ7TZtwH8J445p`, then rerun `bun run setup:devnet`. The corresponding private treasury key is only in ignored `.data/treasury.json`, mode 0600.

The development server was started for the Photon check and left listening on localhost:5173 (API 3000). Restart with `bun run dev` if it exits; keep one listener per project. The installed SDK's unauthenticated `getPlatforms` / `getImessageInfo` helpers returned 401; explicit authenticated requests to those same official management endpoints returned 200. The repeatable credential diagnostic uses the authenticated SDK methods instead. No access token or project secret was logged.

## Private-DM revision checks

Added tests exercise two verified identities joining one logical tab, no-wallet membership, private proposal replies, exact per-person confirmation notices, replay safety, concurrent outbox-drain exclusion, isolated recipient retries, invite expiry/revocation/ownership, demo/live invite separation, STOP/START behavior, immutable earlier splits when someone joins later, active-tab routing, no unknown-contact enrollment, PAY rejection, HTTP authentication, recipient-filtered notifications, bounded receipt entry and visible missing-Gemini behavior.

The new browser walkthrough uses independent organizer/guest contexts and a 390px mobile guest, with no horizontal overflow or browser errors. Screenshots: `.data/screenshots/direct-tab-desktop.png` and `direct-tab-mobile.png`; the mobile output was visually inspected. These are simulated identities and deliveries, not proof of actual iMessage delivery. The persistent SQLite migration preserves previous groups and expense history.

The existing browser smoke check initially assumed Tahoe would always be the first returned tab. New shared tabs exposed that assumption; the test now explicitly selects the Tahoe fixture and passes. The application does not rely on database row order for authorization or financial state.

Repeat browser DM runs now explicitly START notifications for the simulated guest before asserting delivery, then exercise STOP and restore START. The initial repeated run correctly received no update because an earlier STOP was still persisted across tabs.

Gemini key storage uses an external mode-0600 file under a mode-0700 directory; no Gemini secret is stored in the repository or exported into process.env. Configuration tests cover external loading, conflicting sources and redacted file errors. Live Google initially rejected the fully bounded JSON generation schema as too complex. The transport schema now preserves its shape while omitting numeric/length bounds; unchanged Zod validation enforces every original constraint after generation. A live request then succeeded, and additional tests reject excessive totals/lengths, fractional cents and unrecognized payers.

## Railway preparation

Added root Dockerfile, restrictive `.dockerignore`, `railway.json` and DEPLOY_RAILWAY.md. Verified the pinned Bun image manifest exists; TypeScript and frontend build passed. A separate no-credentials production process with temporary SQLite storage passed migrations/startup, served the built UI and `/health` (200), rejected demo login (404), and protected private API access (401). That process was stopped and its temporary data removed. Actual Docker execution was not tested because the local Docker daemon was unavailable. No Railway account actions or cloud deployment were performed. The user reports their local Photon/iMessage flow now works; previous zero-message observations describe earlier checks, not the current user-reported status.
