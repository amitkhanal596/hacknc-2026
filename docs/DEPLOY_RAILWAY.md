# Deploy Tab on Railway

Use one always-running Railway service for the API, Photon listener and built React dashboard, with one persistent volume. No separate frontend or Postgres service is needed. Railway Hobby currently has a $5/month minimum including $5 of resource usage; usage above that costs extra ([pricing](https://docs.railway.com/pricing/plans)).

The root Dockerfile builds the UI, runs typechecking/tests and launches `bun server/src/index.ts`. It excludes local secrets, SQLite data and the separate `server/hellio` Photon echo project. Migrations run automatically at startup, after the volume is mounted. The supplied `railway.json` sets Docker builds, `/health` and restart policy. Container execution has not yet been verified locally because the Docker daemon was not running.

## Dashboard deployment

1. Push the application files, Dockerfile, `.dockerignore`, `railway.json` and lockfile to your GitHub repository. Much of the application is currently untracked locally; a repository containing only the old README will not deploy. Do not commit `.env`, `.data`, secret files or the nested echo project's credentials.
2. In [Railway](https://railway.com), create a project and deploy the GitHub repository. Use the **repository root** as the service root, not `server/hellio`. Railway detects the Dockerfile. Pause/stage the initial deployment while configuring the following; an early attempt without SESSION_SECRET is expected to fail closed.
3. Attach a persistent volume at **`/app/.data`**. That exact path preserves SQLite, its WAL, private receipt bytes stored in SQLite, and optional devnet artifacts across restarts. Do this before accepting any expense data. The mounted volume is not available during the build; no database migration belongs in a build/pre-deploy step ([volumes](https://docs.railway.com/volumes/reference)).
4. Keep **one replica** and **Serverless/sleeping disabled**. This app holds an outbound Photon stream and has a single-server SQLite/outbox design. Do not add a separate worker running the same listener. Volume deployments have a brief restart gap; this MVP does not claim zero downtime.
5. Under service Networking, generate a Railway public domain targeting **port 3000**. Set the exact generated HTTPS origin as APP_BASE_URL (without a trailing slash). This gives phone-accessible links and matching CSRF origin checks.
6. Add the runtime variables below in Railway's Variables UI, then deploy. Store credentials as sealed variables where available. They must not be Docker build arguments, repository files, or frontend VITE_* variables.

```dotenv
HOST=0.0.0.0
PORT=3000
DEMO_MODE=false
APP_BASE_URL=https://YOUR-GENERATED-DOMAIN.up.railway.app
DATABASE_URL=/app/.data/tab.sqlite
PHOTON_ENABLED=true
PHOTON_PROJECT_ID=<existing-project-id>
PHOTON_PROJECT_SECRET=<existing-project-secret>
GEMINI_API_KEY=<existing-gemini-key>
GEMINI_MODEL=gemini-2.5-flash
SESSION_SECRET=<generate-with-openssl-rand-hex-32>
DEMO_CUSTODIAL_WALLETS=false
SOLANA_CLUSTER=devnet
TREASURY_KEY_PATH=/app/.data/treasury.json
```

**Do not set GEMINI_API_KEY_FILE on Railway** when using GEMINI_API_KEY. Your Mac's external credential file is not deployed. The local file remains at `~/.config/tab/gemini-api-key`; copy its value directly into Railway's secret variable using your local editor/password manager, without printing it into shared logs. Photon uses the existing root `.env` credential values. Generate SESSION_SECRET locally with `openssl rand -hex 32` and keep it in Railway variables.

The initial deployment can run messaging, Gemini, expenses and manual settlement without Solana custody enabled. Real devnet payments still need the funded treasury, mint and WALLET_ENC_KEY setup. Keep the treasury/mint files on the mounted volume, and the encryption key in Railway secret variables. No demo wallets or live-value funds are enabled by this deployment file.

## Cut over the listener

Before the hosted listener becomes active, stop local Photon consumers for this project, including a running `server/hellio` echo bot. Keep only the hosted Tab listener active. Don't terminate unrelated local applications. To continue editing the UI locally afterward, set PHOTON_ENABLED=false in the local root `.env` before restarting it.

The cloud volume initially contains a **fresh database**, not your Mac's expense history. Existing local tabs/invites/session links will not exist in that database. For the simplest hackathon launch, create a fresh hosted tab and send new invitations. If the existing real expense history must be retained, first stop the local listener and use SQLite's backup facility to produce a consistent snapshot; securely copy that snapshot to the stopped service's volume before its first live start. Do not copy only a live `.sqlite` file while its WAL is active, and do not upload the database to GitHub. Data migration is a separate operation and has not been performed automatically.

## Verify

1. Open `https://YOUR-DOMAIN/health`; expect `{"ok":true,"service":"tab"}`. This verifies HTTP/database startup, not actual iMessage delivery.
2. Open the domain on your phone. The built UI should load. Demo login cannot create a session in production (`/api/dev/login` returns 404 for a valid same-origin request).
3. Check logs for **authenticated Photon mode**, **AI: gemini**, and **Photon SDK initialized**.
4. In the already-working Photon DM, send `ping`, then `create Hosted dinner`, `invite` and `link`. The reply must link to your HTTPS domain. Open the private link on your phone and verify the session.
5. Add a second registered tester through the invitation. Confirm a small test expense; verify each gets their own notice. Restart the service and verify that the same tab/expense remains, demonstrating volume persistence.
6. Once this succeeds, your Mac can sleep; Railway runs the listener. Monitor Railway logs and usage. `/health` is not a continuous messaging watchdog: if the SDK stream terminates, the server logs the failure and disables DM login; restart the service to reconnect.

No cloud account was accessed, no plan purchased, no credentials uploaded and no public deployment created as part of preparing these files.
