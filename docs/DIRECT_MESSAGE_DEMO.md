# Test Tab through private messages

Tab now works like an invitation-based shared tab: the organizer talks to Tab privately, friends accept an invitation, and Tab sends each participant private purchase updates and a browser link. There is no native iMessage group dependency. This supersedes the original group-chat onboarding in the build prompt.

## Use it locally right now

```sh
bun install
bun run db:migrate
bun run dev
```

Open **http://localhost:5173**. Keep the existing `.env`; it already contains the locally configured Photon credentials. If Bun is not in your shell path, run `export PATH="$HOME/.bun/bin:$PATH"` first. Run only one dev server/listener at once.

1. Choose **Explore as Alex**. On Overview, enter **Friday dinner** under **New tab name**, then **Create shared tab**.
2. Click **Get invitation link**. It opens a generic invitation card, without exposing expenses or signing anyone in. You can copy either the link or its invitation code. Anyone holding the invitation can accept and view shared expense history. Organizer-only **Revoke invitations** disables outstanding links; they otherwise expire after seven days.
3. In another browser profile or an incognito window, open the invitation. Choose the local demo login, switch **Viewing as → Ben**, then **Accept invitation**. Repeat with Casey and Drew for a four-person demonstration. This identity switching is explicitly simulated. Real users sign in through their own Photon DM instead.
4. Return to Alex's window. Membership refreshes every eight seconds when no modal is open. Wait for all four people to appear before proposing a split.
5. Open **Tab messages** and send `I paid $120 for groceries, split with everyone`. With the configured Gemini key, typed purchases now use live structured extraction. Without a key, the constrained parser is labeled simulation. Review the pending proposal in **Overview**, then **Confirm expense**.
6. Each included participant gets an individual outbox update: total $120 and personal share $30. In the local demo these are labeled simulated delivery under **Tab messages**; no iMessages are sent for mock tabs. Alex is owed $90; Ben, Casey and Drew owe $30 each. Switch identities to inspect each person's own update.
7. For receipts without Gemini, use **Simulate dinner receipt**, select the payer and review the split. A real image upload reports that Gemini is required; it never pretends to perform OCR. **Simulate payment screenshot** produces evidence only, with no credit.
8. In **Settle up**, calculate settlements. Use cash for a complete no-credential browser demonstration. A sender's **I've paid** claim does not change their balance. Switch to Alex's separate recipient session and click **I received this exact payment**. Venmo, Apple Cash and Zelle follow the same workflow after Alex supplies their own destination in Payment details.
9. In the DM simulator, `STOP` pauses automatic updates across that person's tabs. `START` resumes future updates. Questions and browser access still work while updates are paused.

`bun run demo:smoke` automatically creates a separate in-memory four-person tab through simulated DMs/invitations. It verifies four $30 notices, a Solana RPC fixture, simulated Venmo and Apple Cash claims with independent recipient confirmation, and exact zero final balances. It sends no real messages or tokens. `bun run test:browser:dm` runs the invitation/private-message browser walkthrough using installed Chrome.

## Use your actual Photon project

Project authentication and shared iMessage token issuance have succeeded. This is distinct from a verified message round trip. The application has not yet observed a successful live user-to-Tab-to-user exchange during recorded checks.

1. In **Photon → hellio → Users**, register each tester's actual iMessage number or email. Use the handle configured under Messages → Send & Receive. Each tester must use the conversation/number assigned to them by Photon; shared numbers may differ by person. You cannot bypass this allowlist by typing a phone number into Tab. [Photon's official shared-plan guidance](https://photon.codes/docs/spectrum-ts/troubleshooting/imessage).
2. Run `bun run check:photon`, then `bun run dev`. Keep your Mac and server running.
3. Privately text `ping`. Expect `Tab is online!`. `@tab ping` also works. The server logs generic receipt/provider-acceptance events without message contents or contact details.
4. Text `name Alex`, `create Tahoe`, then `invite`. Share the invitation with the registered testers. Each texts `join <code>` to their own Tab conversation, then `name Ben`, etc. This explicitly joins the logical tab and enables private purchase updates. It creates no crypto wallet.
5. Text `I paid $120 for groceries, split with everyone` after all participants join. Tab responds with a proposal ID. Text `confirm <id>` only after reviewing the amount, payer and participants. With Gemini configured, a receipt captioned `split this with everyone` becomes a proposal; use `link` to review ambiguous payer/participants in the browser.
6. Tab sends each affected participant their amount and a private one-use browser sign-in link. Each recipient's failed delivery retries independently, up to five attempts, with backoff. The app says **Accepted by Photon** only after the send call succeeds; this is not proof of device delivery. Outbox failure appears as a delivery failure. A crash between remote acceptance and recording success can duplicate a message, never a ledger credit.
7. Text `settle` to generate payment requests. Payers receive private settlement details. Open the browser to choose and explicitly authorize a payment; a chat message or AI response cannot authorize money movement. Manual payment settlement still requires the actual recipient to confirm independently.
8. For multiple tabs, text `tabs`, then `use <tab-id>` with at least eight characters. Replies name the active tab. Notifications carry the relevant tab and a matching private link. `link` gets another sign-in link if the five-minute link expired. `revoke invites` invalidates the organizer's outstanding invitations.

A shareable invitation and a private sign-in link are different. Share only the invitation. Joining grants access to existing shared expenses; it does not retroactively add the new person to old splits. Only confirmed purchases generate automatic share notices. Unknown names are not silently enrolled or charged.

## Phone-accessible browser links

The current `APP_BASE_URL=http://localhost:5173` works on this Mac. On an iPhone, localhost points to the phone itself. The DM text flow can be tested while the server is local, but phone browser links need a reachable HTTPS address.

For a deployment or tunnel to the built server, configure:

```dotenv
DEMO_MODE=false
HOST=127.0.0.1
PORT=3000
APP_BASE_URL=https://your-tab-host.example
SESSION_SECRET=<a-random-secret-of-at-least-32-characters>
PHOTON_ENABLED=true
```

Use `HOST=0.0.0.0` only when the hosting environment requires it. Keep Photon and other credentials in server environment variables. Generate a session secret with `openssl rand -hex 32`. Then run `bun run build` and `bun run start`, and connect your HTTPS reverse proxy/tunnel to port 3000. Do not expose the demo identity-switching mode. Hosting/tunnel provisioning is not included or claimed complete. Existing demo groups cannot be accessed by simulated identities as real Photon groups.

## What is still needed

| Item | Current state | Needed for |
| --- | --- | --- |
| Photon project ID/secret | Configured locally; authentication verified | No additional Photon credential needed |
| Photon tester registration and live ping | Manual dashboard enrollment; live round trip not yet verified | Sending/receiving real DMs for each tester |
| `GEMINI_API_KEY_FILE` + `GEMINI_MODEL` | External protected key configured; live text extraction verified with gemini-2.5-flash. Real receipt OCR still unverified. | Actual receipt OCR and flexible natural-language parsing; model must be available in your account and support structured output |
| Public HTTPS `APP_BASE_URL`, non-demo session secret, persistent host | Not configured | Invitation and private dashboard links opened from phones |
| Funded devnet treasury + test mint | Setup previously blocked by public faucet HTTP 429; no live transfer completed | Real Solana settlement and explorer proof |
| `WALLET_ENC_KEY` + `DEMO_CUSTODIAL_WALLETS=true` | Not configured | Encrypted demo wallets for only those choosing Solana |
| Venmo / Apple Cash / Zelle credentials | Not required by the manual adapter | Recipient supplies their destination; payment occurs independently and recipient confirms |

For Solana, fund the public devnet treasury address printed by `bun run setup:devnet`, rerun setup, set the wallet configuration, and restart. Then Ben can choose real Solana while Casey chooses Venmo and Drew Apple Cash. Until that succeeds, the offline fixture is labeled simulation and the UI does not invent an explorer signature. See [README Solana setup](../README.md#solana-devnet-setup).

No scheduled reminders, automatic discovery/invitation of arbitrary phone numbers, provider-verified manual payments, or native iMessage group features are claimed. The current shared-plan pilot enrolls participants through invitations and verified individual conversations.
