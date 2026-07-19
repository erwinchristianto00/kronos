# Deploy: run the bot 24/7 (free) with the dashboard online

Runs the **API (trading brain) + Web dashboard + Kronos** on a free always-on Linux
box, so it keeps trading and scanning without your laptop. A VPS **outside Indonesia**
also removes the Binance geo-block — **no WARP needed there**.

## Why a real VM (not Render/Railway/Replit free tiers)
Those free PaaS tiers **sleep when idle** — that kills the every-7-minute scan loop.
You need an always-on VM. Best free option: **Oracle Cloud "Always Free"**; best cheap-paid
option: **Contabo** (below).

---

## ⚠️ Current production topology (read this before touching Caddy)

The steps below describe setting up **one fresh VM with one checkout**. What's actually running
in production today is **three separate checkouts of this repo on one Contabo VPS**, behind
**one shared Caddy instance**:

| Path       | API port | Checkout (on the VPS)                          | Deploy method |
|------------|----------|--------------------------------------------------|---------------|
| `/`        | 3101     | `~/daily-trading-cockpit-v2` (main)             | `deploy.sh` — a real git repo (commit → push → pull → build → pm2 restart) |
| `/testnet` | 3102     | `~/kronos-testnet/daily-trading-cockpit-v2`     | **rsync only — NOT a git repo.** `git push` does nothing here. |
| `/live`    | 3103     | `~/kronos-live/daily-trading-cockpit-v2`        | **rsync only — NOT a git repo. Real money.** |

`deploy/Caddyfile` reflects this exact 3-instance shape — keep it in sync with whatever's
actually installed at `/etc/caddy/Caddyfile` on the box (they've drifted apart before, which is
part of why Caddy confusion keeps recurring).

**The two gotchas that cause almost every "why isn't my fix showing up" moment:**

1. **`/testnet` and `/live` are rsync-only.** Committing and pushing to git changes NOTHING on
   those two instances until someone explicitly rsyncs the changed files into that specific
   checkout on the VPS. A frontend or backend change only reaches `/` automatically (via
   `deploy.sh`); `/testnet` and `/live` need their own manual copy + rebuild + (for backend
   changes) `pm2 restart`.
2. **No frontend is served by a running Node process.** Every path (`/`, `/testnet`, `/live`) is
   served by Caddy's `file_server` reading that checkout's `apps/web/dist` directly off disk —
   there is nothing to restart for a frontend-only change, just `npm run build -w @dtc/web` inside
   the right checkout. In particular, **`pm2 restart dtc-web` only affects the `/` (main) instance**
   — its working directory is the main checkout, it has no relationship to `/testnet` or `/live`
   at all, and restarting it does nothing for a `/testnet` or `/live` frontend deploy (a mistake
   made in this exact repo before — see `pm2 describe dtc-web`'s `exec cwd` to confirm which
   checkout it's actually bound to before assuming it's relevant).

Because `/api/*` and `/assets/*` requests from a `/testnet` or `/live` page are requested by the
browser without any path prefix, Caddy tells them apart from the main instance's identical-looking
requests using the `Referer` **header**, not the URL — see the comments in `deploy/Caddyfile` for
the exact matcher blocks (`@liveApi`, `@liveAssets`, etc.) before editing routing rules.

---

## 0. Contabo (recommended — cheap, no capacity lottery)  ⭐
The same deploy package runs as-is on a Contabo VPS, and Contabo is the easiest path:
no ARM capacity lottery, ~€5–7/mo for **4 vCPU / 8 GB**, x86 Ubuntu, generous traffic,
no sleep. 8 GB easily runs API + Web + **Kronos** (torch ~2 GB).

- **Buy**: Cloud VPS, **Ubuntu 22.04**, **≥8 GB RAM**. Region **EU/Germany (default) or Singapore** —
  both reach Binance fine (no geo-block, **no WARP**). Provisioning can take a few hours.
- **⚠️ Contabo has NO default firewall** (unlike Oracle/GCP). Your `/api` has unauthenticated
  arm/kill — lock it down FIRST thing:
  ```bash
  ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
  ```
  Then put **Caddy** (step 7) in front for the dashboard. Never expose 3101/5173 raw.
- **Login is `root`** by default — either work as root, or `adduser ubuntu && usermod -aG sudo ubuntu`
  and use that. Adjust the `deploy/Caddyfile` `root` path to wherever you cloned the repo.
- Then follow **steps 2–7 below** (clone → setup-vps.sh → pm2 → Caddy).

### Start fresh (recommended) vs migrate
- **Start fresh** (clean edge): just **don't copy any `apps/api/data/*.json`** in step 3 — the bot
  initializes empty and learns forward edge from scratch. Cleaner than carrying the optimistic seed.
- The bot only builds edge from **HEADLINE** trades. So that they actually start flowing soon, the
  `.env` ships **collection-speed knobs** (lower OOS bars): `WATCHABLE_MIN_FRESH=10`, `GUARDRAIL_MIN_OOS=10`.
  Lanes go live-eligible after ~10 closes instead of 20/30. Raise them back toward 20/30 once real
  headline trades have accumulated and you want stricter evidence. (The edge gate still needs its own
  30 samples before it vetoes/allows a slice, so this controls trade *flow*, not veto rigor.)

---

## 1. Create the free VM (Oracle Cloud Always Free)

### Picking a region (this is where people get stuck)
The hard part is the **"Out of host capacity"** error on the free ARM shape. Two facts decide your odds:
- **Multi-AD regions get capacity far more often.** Regions with 3 Availability Domains —
  **Ashburn (`us-ashburn-1`)**, **Frankfurt (`eu-frankfurt-1`)**, **London (`uk-london-1`)** — beat
  single-AD ones (e.g. Singapore). You can retry across AD-1/AD-2/AD-3.
- **Latency doesn't matter for this bot** (it scans every 7 min), and US/EU are **not** Binance-geo-blocked.
  So prefer a 3-AD region for capacity over a "closer" one. **Recommended home region: `us-ashburn-1`.**
- Your **home region is chosen at signup and is permanent** — pick the 3-AD region then.
- (Want APAC? Singapore works but is single-AD → expect more capacity retries.)

### Create it
- Sign up at cloud.oracle.com (needs a card for verification — Always-Free resources are not charged).
- Compute → Create Instance:
  - Shape → **Ampere (ARM)** → **VM.Standard.A1.Flex**, e.g. **2 OCPU / 12 GB** (Always Free = up to 4/24).
    1 OCPU/6 GB runs API+Web; use ≥2 OCPU/8 GB for Kronos.
  - Image: **Ubuntu 22.04**.
  - In **Placement**, if AD-1 says "out of capacity", try **AD-2** then **AD-3**.
  - Add your SSH public key. Note the **public IP**.

### If every AD is "out of capacity" → auto-grab it
This is normal and solvable. Run a small script that retries the create-API every ~minute and
launches the instance the instant capacity frees up (minutes to a day or two):
- `hitrov/oci-arm-host-capacity` (PHP) or `oeufmeister/oci-arm-host-capacity` — set your OCI API
  keys + shape, leave it running, it grabs the box automatically. (Search those repo names.)

_(Smaller free alt with no capacity lottery: Google Cloud `e2-micro`, always-free, US region, ~1 GB →
API+Web only, run with `KRONOS_ENABLED=0`. See the GCP box below.)_

### Alternative: Google Cloud Free (e2-micro) — easier to get, smaller
No ARM capacity lottery, but trade-offs:
- **`e2-micro`, 1 GB RAM, US region only** (`us-west1` / `us-central1` / `us-east1`) — US isn't Binance-geo-blocked, so still no WARP. 1 GB → **API + Web only, no Kronos** (`KRONOS_ENABLED=0`). The setup script auto-adds a 2 GB swapfile so the build doesn't OOM.
- **Egress cap: 1 GB/month free** (from North America). The bot's own Binance traffic is tiny (~tens of MB/mo — requests are small, candle responses are *ingress* = free). The risk is the **dashboard**: leaving it open polling 24/7 sends data US→you. Check it occasionally, don't stream it all day.
- **It's an allowance, not a hard cap** (unlike Oracle Always-Free). Set a **Budget alert at $1** (Billing → Budgets & alerts) so an accident can't surprise-bill you.
- Create: Compute Engine → Create → **e2-micro**, region `us-west1`, **Ubuntu 22.04**, allow it, add SSH key. Then the same steps 2–6 below, but run `KRONOS_ENABLED=0 bash deploy/setup-vps.sh`.

## 2. SSH in
```bash
ssh ubuntu@<VM_PUBLIC_IP>
```

## 3. Get the code + your config + your data
```bash
git clone <your-repo-url> daily-trading-cockpit-v2
cd daily-trading-cockpit-v2
```
From your **laptop**, copy your `.env` and your trained state over (so the bot is smart on day one):
```bash
scp .env ubuntu@<VM_IP>:~/daily-trading-cockpit-v2/.env
scp apps/api/data/regime-edge-memory.json apps/api/data/paper-execution-router.json \
    apps/api/data/live-execution.json ubuntu@<VM_IP>:~/daily-trading-cockpit-v2/apps/api/data/
```
> On the VM, `.env` keeps `LIVE_BINANCE_ENV=testnet`, `LIVE_MIRROR_ALL_PAPER=0`, mainnet keys commented. Leave `BINANCE_HTTPS_PROXY` blank — no WARP needed off-Indonesia.

## 4. Run the installer
```bash
bash deploy/setup-vps.sh                 # full stack (API + Web + Kronos)
# or, on a small box:
KRONOS_ENABLED=0 bash deploy/setup-vps.sh # API + Web only
```
It installs Node + Python, builds everything, sets up Kronos, and starts all services under **pm2**.
Then make it survive reboots:
```bash
pm2 startup        # run the 'sudo env PATH=... pm2 startup ...' line it prints
pm2 save
```

## 5. Open the dashboard port (TWO firewalls on Oracle)
1. **Oracle Console** → Networking → your VCN → **Security List** → Add **Ingress Rule**: source = **your IP/32** (not 0.0.0.0/0), TCP, dest port **5173**.
2. **On the VM**:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 5173 -j ACCEPT
   sudo netfilter-persistent save
   ```
Open the dashboard: `http://<VM_PUBLIC_IP>:5173`

## 6. ⚠️ SECURITY — read before exposing anything
The dashboard's `/api` includes **unauthenticated arm / disarm / kill** endpoints. If you open
port 5173 to `0.0.0.0/0`, **anyone with the IP can control your bot.** It's testnet (fake money),
but still. Pick one:
- **Safest (recommended): don't open any port. Use an SSH tunnel** when you want the dashboard:
  ```bash
  ssh -L 5173:localhost:5173 ubuntu@<VM_IP>
  # then browse http://localhost:5173 on your machine
  ```
- **OK: restrict the Oracle Security List ingress to your own IP** (step 5 above). Re-edit if your IP changes.
- **Access from anywhere, with a password + HTTPS:** put **Caddy** in front (one binary: serves the
  dashboard, proxies `/api`, does basic-auth + auto-HTTPS). Ask and I'll add a `Caddyfile`.

## 7. (Recommended) Access from anywhere securely — Caddy + password + HTTPS
Instead of opening port 5173, put **Caddy** in front: it serves the dashboard, proxies `/api`,
adds a **password**, and gets **auto-HTTPS**. Then you only expose 80 + 443, and `dtc-web`/5173
can stay closed. A `deploy/Caddyfile` is included.

1. **Free domain** (needed for real HTTPS): make one at **duckdns.org** (sign in, pick a name,
   set its IP to your VM's public IP). You get e.g. `yourbot.duckdns.org`.
2. **Install Caddy** on the VM:
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   ```
3. **Make a password hash**: `caddy hash-password` (type your password; copy the `$2a$...` hash).
4. **Edit `deploy/Caddyfile`**: set your `yourbot.duckdns.org`, the `admin` user + the hash, and the
   `root` path if your repo isn't at `/home/ubuntu/...`. Then:
   ```bash
   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
   sudo systemctl restart caddy
   ```
5. **Firewall**: open **80 + 443** (Oracle Security List → 0.0.0.0/0 is OK here since Caddy has the
   password; plus on the VM `sudo iptables -I INPUT 6 ... --dport 80/443 ... ACCEPT && sudo netfilter-persistent save`).
   Do **not** open 5173. Optionally `pm2 delete dtc-web` (Caddy serves the dashboard now).
6. Open `https://yourbot.duckdns.org` from any device → enter your password. Done.

> No domain? Use the commented IP-only block in the `Caddyfile` (`tls internal`) — works on the raw
> IP with a one-time browser cert warning.

## Day-to-day
```bash
pm2 status                 # are all 3 up?
pm2 logs dtc-api           # live API/scan logs (Ctrl-C to exit)
pm2 restart all            # after pulling code changes
pm2 stop dtc-api           # pause trading
```
Update after `git pull`: `npm install && npm run build && pm2 restart all`.

Health checks: `curl localhost:3101/api/health` · `curl localhost:8001/health` (Kronos).
