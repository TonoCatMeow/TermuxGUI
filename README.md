# deploy-gui — Termux Deploy-Server GUI

A single Node/TypeScript app that runs entirely inside **Termux on Android** and exposes
**one web GUI** (no CLI) covering:

1. **Apps** — deploy code (git clone/pull, zip upload, or paste a file inline) and run it as a
   managed background process with start/stop/restart and live log streaming.
2. **Workflows** — save named shell snippets, run them from a button, watch live output,
   see run history (exit code, duration).
3. **Dashboard** — live CPU / RAM / storage / uptime / request-count plus top processes,
   pushed over socket.io every ~2.5s.
4. **Cloudflare tunnels** — run a **named** Cloudflare Tunnel via
   `cloudflared tunnel run --token <token>`, exposing the hostname(s) you configured on your
   **own domain** in the Zero Trust dashboard. No random `trycloudflare.com` URLs.
5. **Terminal** — a real interactive shell in the browser: `node-pty` on the backend,
   xterm.js on the frontend, copy/paste buttons for mobile, PTY resize on window resize.
6. **Settings** — regenerate the access token, view shell / `$PREFIX` / sshd status.

## Target environment

This runs **inside Termux on Android (aarch64)**, not desktop Linux:

- No `sudo`, no `systemd`. Managed processes are plain `child_process.spawn` children.
- `$PREFIX` is `/data/data/com.termux/files/usr`, not `/usr`.
- The shell is resolved from `$SHELL` → `which bash` → `$PREFIX/bin/bash` → `/bin/sh`
  (`src/shell.ts`) — **`/bin/bash` is never assumed**.
- `node-pty` is a native module and is **compiled on-device** during `npm install`.
  Do not `npm install` on a desktop and copy `node_modules` over — the architecture/libc differ.

## Setup (on the phone, in Termux)

```sh
pkg install nodejs git cloudflared
git clone <your repo> ~/deploy-gui && cd ~/deploy-gui
npm install        # this is where node-pty compiles — must happen on the phone
npm run build      # tsc -> dist/
node dist/server.js
```

On first start it prints an **access token** and URLs, e.g.:

```
  Local:   http://localhost:8080
  Network: http://192.168.1.42:8080
  Access token (paste once in the browser login screen):
  xK9...
```

Open the URL in any browser on the same Wi-Fi (or on the phone itself), paste the token once.
The server sets a signed session cookie; all API routes and the socket require it.

Optional: `PORT=9000 node dist/server.js` to change the port (default `8080`).

## Cloudflare tunnel setup (one-time, in the Zero Trust dashboard)

1. <https://one.dash.cloudflare.com> → **Networks → Tunnels → Add a tunnel** → cloudflared.
2. Name it, then under **Public Hostnames** add e.g. `deploy.yourdomain.com` →
   `http://localhost:8080` (add more hostnames for other local ports as needed).
3. Copy the tunnel's **token** (the long `eyJ...` string from the install command).
4. In the GUI → **Tunnels** tab: paste the token once, press **Save token**, then **Start tunnel**.

The app never talks to the Cloudflare API and never manages DNS — `cloudflared` reads the
hostname→port mapping from Cloudflare using the token. The token is stored in
`~/.deploy-gui/state.json` (mode 600) and never shown again in the UI. A **TUNNEL ACTIVE**
badge shows in the nav bar whenever the tunnel is running; stop it when you don't need
remote access.

## Security notes (read these)

- **This GUI can execute arbitrary code on the phone** — that is the deploy/workflow/terminal
  feature by design. The access token is the only gate. Treat it like a server room key.
- Plain HTTP on the LAN by default — the same tradeoff as similar home-network tools.
  When away from home, use the Cloudflare tunnel (HTTPS on your own domain) instead of
  port-forwarding your router.
- Login is rate-limited (5 tries → 60s lockout), the token check uses
  `crypto.timingSafeEqual`, and session cookies are HMAC-signed with a random secret
  generated on first run.
- The tunnel token is itself a secret (it lets cloudflared connect *as* that named tunnel).
  It is stored like the access token and never echoed back after saving.
- Sessions are in-memory: restarting the server logs everyone out. "Regenerate access token"
  additionally invalidates every session immediately.

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/login` | Body `{token}` → sets signed session cookie (rate-limited) |
| POST | `/logout` | Clear session |
| GET | `/api/health` | One-shot health snapshot |
| GET/POST | `/api/apps` | List apps / create app (`git` or `inline`) |
| POST | `/api/apps/upload` | Create app from zip upload (multipart) |
| POST | `/api/apps/:name/start` `/stop` `/restart` | Control an app |
| DELETE | `/api/apps/:name?deleteFiles=1` | Remove app (optionally its files) |
| GET/POST | `/api/workflows` | List / create workflows |
| POST | `/api/workflows/:id/run` | Trigger a run (output streamed via socket) |
| DELETE | `/api/workflows/:id` | Delete workflow |
| GET | `/api/tunnel` | Tunnel status (running, token-saved, binary check) |
| POST | `/api/tunnel/token` `/start` `/stop` | Manage the tunnel |
| GET | `/api/settings` | Shell / prefix / sshd info |
| POST | `/api/settings/regenerate-token` | New token, all sessions invalidated |

Socket.io events: `health:update`, `app:log`, `app:status`, `workflow:log`,
`workflow:status`, `workflow:history`, `tunnel:status`, and
`term:start` / `term:input` / `term:output` / `term:resize` for the terminal.

## Layout

```
deploy-gui/
├── src/
│   ├── server.ts             # express + socket.io bootstrap, terminal PTY wiring
│   ├── auth.ts               # token check, signed session cookies, login rate limit
│   ├── state.ts              # ~/.deploy-gui/state.json read/write
│   ├── shell.ts              # Termux-aware $SHELL resolution
│   ├── system-stats.ts       # systeminformation wrapper, 2.5s emitter
│   ├── apps-manager.ts       # spawn/track/kill managed app processes
│   ├── workflows-manager.ts  # run saved commands, stream output, history
│   ├── deploy.ts             # git clone/pull, zip extract, inline write
│   ├── tunnel-manager.ts     # spawn/kill cloudflared (named tunnel, token)
│   └── routes/               # auth, apps, workflows, tunnels, settings
├── public/                   # index.html + styles.css + app.js (no build step)
│   └── vendor/               # xterm.js + fit addon, served locally (no CDN needed)
├── package.json
└── tsconfig.json
```

State lives in `~/.deploy-gui/state.json` (override with `DEPLOY_GUI_HOME`).
Apps deploy into `~/deploy-apps/<name>/` (override with `DEPLOY_APPS_DIR`).

## Frontend notes

Plain HTML/CSS/vanilla JS served by Express — no framework, no build step, easy to tweak
right on the phone (e.g. with `nano` or ACode) and reload. xterm.js is vendored under
`public/vendor/` so the GUI works with no internet access at all.
