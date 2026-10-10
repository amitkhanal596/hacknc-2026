# Deploying Tab to Railway

Takes about 20 minutes. When you're done, Tab runs 24/7 at a fixed `https://….up.railway.app` address, and you won't need your laptop or `npm run phone` anymore.

**Why Railway:** Tab needs a server that's always running (it keeps a live connection to Photon and runs reminder jobs), a disk that survives redeploys (the SQLite database), and a fixed HTTPS address (Apple Pay and Stripe webhooks). Railway gives all three with the least setup. Serverless hosts (Vercel, Netlify) can't run Tab. Render's free tier sleeps and would drop the Photon connection.

**Cost:** Railway's trial credit covers testing. After that, the Hobby plan is about $5/month, and Tab fits within it.

The repo is already prepared (`server/railway.json`, production start command, Node 22 pinned), so these steps are all clicks plus one command.

---

## Step 1: Create a Railway account
1. Go to **https://railway.com** and sign up **with GitHub**. This makes connecting the repo one click.
2. If it asks you to verify or pick a plan, the trial is fine for now.

## Step 2: Create the project from GitHub
1. Click **New Project → Deploy from GitHub repo**.
2. If asked, click **Configure GitHub App** and give Railway access to **`amitkhanal596/hacknc-2026`**.
3. Pick **hacknc-2026**. Railway creates a service and starts a first build. **It will fail or crash. That's expected**, because it doesn't know where the server is yet. Continue.

## Step 3: Point it at the right branch and folder
Click the service, then open **Settings**:
1. **Source → Branch:** change to **`amit-branch`**. Everything lives there; `main` is empty.
2. **Source → Root Directory:** set to **`/server`**. The repo root only has docs; the app is in `server/`.
3. Railway reads `server/railway.json`, which sets the start command (`npm start`), the health check (`/health`), restart-on-crash, and exactly 1 copy. If **Deploy → Healthcheck Path** is still empty after the next deploy, type `/health` there yourself.

> **Why one copy:** SQLite is a single file on a single disk, and two copies of the bot would also both answer every text.

## Step 4: Add a volume (where the database lives)
1. On the project canvas, press **⌘K** (or right-click the empty canvas), choose **Volume**, and attach it to the Tab service.
2. **Mount path:** **`/data`**.

> **Why:** Railway wipes the server's own disk on every deploy. The volume is a separate disk that persists, so groups, expenses, and payments survive redeploys.

## Step 5: Copy your keys into Railway
1. On your Mac, copy your local keys to the clipboard (this prints nothing):
   ```bash
   pbcopy < ~/repos/hacknc-2026/server/.env
   ```
2. In Railway: the service → **Variables → Raw Editor**. Paste, then **change these lines** before saving:

   | Variable | Set it to | Why |
   |---|---|---|
   | `DATABASE_PATH` | `/data/tab.db` | Puts the database on the volume from step 4 |
   | `PORT` | `3000` (leave as is) | The address in step 6 forwards to this port |
   | `DEMO_MODE` | `true` for the hackathon | Reminders and auto-approve take minutes instead of hours. Set `false` for real use. |
   | `PUBLIC_BASE_URL` | leave for now | Filled in at step 6 |
   | `STRIPE_WEBHOOK_SECRET` | leave for now | Replaced at step 7 (the local one only works with `stripe listen`) |

3. Click **Update Variables**. Railway redeploys automatically.

> Keys stay in Railway's encrypted variables, never in git. Everything else carries over unchanged: Photon, Gemini, Solana treasury and token, `WALLET_ENC_KEY`, `APP_SECRET`, Stripe keys.
>
> **Keep `WALLET_ENC_KEY` the same everywhere.** It decrypts users' Solana wallets. If it changes, the server can't use wallets created with the old key.

## Step 6: Get the public address
1. Service → **Settings → Networking → Generate Domain**.
2. When it asks for a port, enter **`3000`**.
3. You get something like **`https://tab-production-1234.up.railway.app`**. Copy it.
4. **Variables:** set `PUBLIC_BASE_URL` to that address (no trailing slash). Save, and it redeploys.

> **Why:** invite links, pay links, the Stripe Connect return page, and the QR code on the home page are all built from `PUBLIC_BASE_URL`.

## Step 7: Point Stripe at the new address (one command on your laptop)
```bash
cd ~/repos/hacknc-2026/server
npm run setup:stripe -- https://tab-production-1234.up.railway.app
```
This:
- **registers the domain for Apple Pay.** Without it, the Apple Pay button doesn't show.
- **creates a real Stripe webhook endpoint** at `…/stripe/webhook`. It replaces `stripe listen`, which only worked while your laptop was running.
- prints a new **`whsec_…`** secret. In Railway **Variables**, set `STRIPE_WEBHOOK_SECRET` to it and save.

> **Why:** Stripe's webhook is the only thing that marks an Apple Pay payment as paid. If the secret doesn't match, the server rejects Stripe's messages.

## Step 8: Check the deploy logs
Service → **Deployments → latest → Deploy Logs**. You should see:
```
Tab server on http://localhost:3000 (public: https://tab-production-1234.up.railway.app)
  Spectrum iMessage: on
  Gemini:            on  (gemini-3.8-flash → …)
  Solana devnet:     on
  Stripe Apple Pay:  on
```
If you see `⚠️ Using dev APP_SECRET / WALLET_ENC_KEY`, those variables didn't get copied. Redo step 5.

## Step 9: Stop the laptop server
On your Mac, stop `npm run phone` (Ctrl+C in its terminal, or close it).

> **Why:** both servers would be connected to the same Photon project, so every text would get **two** replies, and they'd keep separate databases.

## Step 10: Test the live deployment
1. **https://YOUR-APP.up.railway.app/health** → `{"ok":true}`
2. Open the home page on your iPhone, enter your name and number, and you should get your Tab number (+1 415-605-5838 for you).
3. Text Tab `new trip Test` and open the invite link on a second phone.
4. Send a receipt photo, approve, then `SETTLE`, and try **Apple Pay** and **PAY**.
5. In the Stripe Dashboard → **Developers → Webhooks**, your endpoint should show successful (200) deliveries after an Apple Pay payment.

The Railway database starts empty, since your laptop's `data/tab.db` isn't copied. Everyone's Photon registration lives in Photon, so re-signing up on the site gives the same Tab numbers.

---

## After it's live

- **Updating:** push to `amit-branch` and Railway redeploys automatically. The database on the volume is kept.
- **Logs:** Service → Deployments → Deploy Logs. `[gemini]`, `[stripe]`, and `[bot]` lines show what's happening.
- **Restarts:** if the server crashes, Railway restarts it (up to 10 times in a row).
- **Custom domain (optional):** Settings → Networking → Custom Domain, add a DNS record, then re-run step 7 with the new domain and update `PUBLIC_BASE_URL`.
- **Backups:** the database is one file on the volume. Before risky changes, download it from Railway's volume tab or copy it with the Railway CLI.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails mentioning `better-sqlite3` or the Node version | Make sure Railway uses Node 22 (`server/package.json` pins `22.x`). In Variables you can also set `RAILPACK_NODE_VERSION=22` or `NIXPACKS_NODE_VERSION=22`. |
| "Application failed to respond" / health check fails | The domain's port (step 6) must match `PORT` (3000). |
| Every text gets two replies | The laptop server is still running (step 9). |
| Apple Pay button missing | Re-run step 7. Use Safari on an iPhone with a card in Wallet. |
| Apple Pay payment never shows as paid | `STRIPE_WEBHOOK_SECRET` doesn't match. Re-run step 7 with `--recreate` and update the variable. |
| Data disappeared after a deploy | The volume isn't mounted at `/data`, or `DATABASE_PATH` isn't `/data/tab.db` (steps 4–5). |
| "I can't read photos right now" | Gemini free-tier quota (20/day per model). Turn on billing for the key (see TESTING.md §6). |
