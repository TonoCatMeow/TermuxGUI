# deploy-gui — Deploy-Server GUI for proot-distro Debian on Android

A single Node/TypeScript app that runs **inside a proot-distro Debian container in Termux
on Android**, as **root**, and exposes **one web GUI** (no CLI) covering:

1. **Apps** — deploy code (git clone/pull, zip upload, or paste a file inline) and run it as a
   managed background process with start/stop/restart and live log streaming. Assign each app a
   **port** (exported to the process as `$PORT`), or mark it as a **static site** and the built-in
   file server serves its directory on that port — no start command needed.
2. **Workflows** — save named shell snippets, run them from a button, watch live output,
   see run history (exit code, duration).
3. **Dashboard** — live CPU / RAM / swap / storage / uptime / request-count plus top processes,
   pushed over socket.io every ~2.5s.
4. **Terminal** — a real interactive shell in the browser: `node-pty` on the backend,
   xterm.js on the frontend, copy/paste buttons for mobile, PTY resize on window resize.
5. **Settings** — regenerate the access token, view shell / user / sshd status.

## Target environment

The stack is: **Android phone → Termux → `proot-distro` Debian → this app (as root)**.

What that means for the code:

- **Standard Debian/FHS layout inside the container** — `/bin/bash` exists, `/usr` is normal,
  no Termux `$PREFIX`. The shell is still resolved defensively
  (`$SHELL` → `which bash` → `/bin/bash` → `/bin/sh`, see `src/shell.ts`).
- **No systemd, no sudo needed** — proot containers don't boot systemd; managed processes are
  plain `child_process.spawn` children of the Node server, and everything already runs as root.
- **aarch64** — `node-pty` is a native module and is **compiled inside the container** during
  `npm install`. Do not `npm install` on a desktop/other machine and copy `node_modules` over.
- The container **shares the phone's network** (proot is not a VM with its own NIC), so the GUI
  is reachable at `http://<phone-wifi-ip>:8080` exactly like a bare-Termux server would be.
- Paths bound into the container by Termux/proot (e.g. shared Android storage) are reachable
  from managed apps, workflows, and the terminal — as root.

## Setup (on the phone)

In **Termux** (once):

```sh
pkg install proot-distro
proot-distro install debian
proot-distro login debian
```

Everything below runs **inside the Debian container** (after `proot-distro login debian`),
as root:

```sh
apt update
apt install -y nodejs npm git curl python3 make g++
```

> Debian 12 (bookworm) ships Node 18, which satisfies the Node 18+ requirement.
> `python3 make g++` are needed to compile node-pty's native module.

Get the code in and start it:

```sh
git clone <your repo> ~/deploy-gui && cd ~/deploy-gui
npm install        # this is where node-pty compiles — must happen inside the container
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

## Static sites and ports

When creating an app you can assign it a **port**:

- **Command apps** get the port exported as the `$PORT` environment variable — write your app
  to bind `process.env.PORT` and it's reachable at `http://<phone-ip>:<port>`.
- **Static sites** (check "Static site" in the form) skip the start command entirely: the
  built-in file server serves the app's directory on the assigned port with correct content
  types, `index.html` for directories, and path-traversal protection. Works with any deploy
  method — upload a zip of your site, git-clone it, or paste a single `index.html` inline.

All apps bind `0.0.0.0`, so assigned ports are reachable by every device on your network.

## Security notes (read these)

- **This server runs as root** and can execute arbitrary code — that is the
  deploy/workflow/terminal feature by design. The access token is the only gate.
  Treat it like a server room key.
- proot is **not a hard security boundary**: paths bound from Termux/Android shared storage
  are reachable from inside the container, as root.
- Plain HTTP on the LAN by default — the same tradeoff as similar home-network tools.
  Don't port-forward it on your router without understanding the risk.
- Login is rate-limited (5 tries → 60s lockout), the token check uses
  `crypto.timingSafeEqual`, and session cookies are HMAC-signed with a random secret
  generated on first run.
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
| GET | `/api/settings` | Shell / user / sshd info |
| POST | `/api/settings/regenerate-token` | New token, all sessions invalidated |

App creation accepts `port` (1-65535) and `isStatic` on both `POST /api/apps` and
`POST /api/apps/upload`. Static apps skip the start command; command apps get `port`
exported as `$PORT`.

Socket.io events: `health:update`, `app:log`, `app:status`, `workflow:log`,
`workflow:status`, `workflow:history`, and
`term:start` / `term:input` / `term:output` / `term:resize` for the terminal.

## Layout

```
deploy-gui/
├── src/
│   ├── server.ts             # express + socket.io bootstrap, terminal PTY wiring
│   ├── auth.ts               # token check, signed session cookies, login rate limit
│   ├── state.ts              # /root/.deploy-gui/state.json read/write
│   ├── shell.ts              # defensive $SHELL resolution (Debian/FHS)
│   ├── system-stats.ts       # systeminformation wrapper, 2.5s emitter
│   ├── apps-manager.ts       # spawn/track/kill managed app processes
│   ├── workflows-manager.ts  # run saved commands, stream output, history
│   ├── deploy.ts             # git clone/pull, zip extract, inline write
│   ├── static-server.ts      # in-process static file server for static-site apps
│   └── routes/               # auth, apps, workflows, settings
├── public/                   # index.html + styles.css + app.js (no build step)
│   └── vendor/               # xterm.js + fit addon, served locally (no CDN needed)
├── package.json
└── tsconfig.json
```

State lives in `/root/.deploy-gui/state.json` (override with `DEPLOY_GUI_HOME`).
Apps deploy into `/root/deploy-apps/<name>/` (override with `DEPLOY_APPS_DIR`).

## Frontend notes

Plain HTML/CSS/vanilla JS served by Express — no framework, no build step, easy to tweak
right on the phone (e.g. with `nano` in the container, or ACode in Android) and reload.
xterm.js is vendored under `public/vendor/` so the GUI works with no internet access at all.
