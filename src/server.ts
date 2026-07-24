import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import { Server, Socket } from 'socket.io';

import { isValidSessionCookie, requireAuth } from './auth';
import { AppsManager } from './apps-manager';
import { getState, loadState } from './state';
import { StatsEmitter } from './system-stats';
import { WorkflowsManager } from './workflows-manager';
import { resolveShell } from './shell';

import { authRoutes } from './routes/auth.routes';
import { appsRoutes } from './routes/apps.routes';
import { settingsRoutes } from './routes/settings.routes';
import { workflowsRoutes } from './routes/workflows.routes';

// node-pty is a native module compiled on-device (aarch64, inside the proot Debian container).
// Load it lazily so the rest of the server still starts if it's missing.
type IPty = {
  pid: number;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};
type PtySpawn = (file: string, args: string[], opts: Record<string, unknown>) => IPty;
let ptySpawn: PtySpawn | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ptySpawn = (require('node-pty') as { spawn: PtySpawn }).spawn;
} catch (err) {
  console.warn('[deploy-gui] node-pty not available — Terminal tab will be disabled.', err);
}

loadState();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---- request counting (shown on the dashboard) ----
let requestCount = 0;
app.use((_req, _res, next) => {
  requestCount += 1;
  next();
});

app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');

// ---- managers ----
const apps = new AppsManager(io);
const workflows = new WorkflowsManager(io);
const stats = new StatsEmitter(io, () => requestCount);

// ---- public routes ----
app.use(authRoutes());

// ---- protected API ----
const api = express.Router();
api.use(requireAuth);
api.get('/me', (_req, res) => res.json({ ok: true }));
api.get('/health', (_req, res) => {
  stats
    .snapshot()
    .then((s) => res.json(s))
    .catch((e) => res.status(500).json({ error: String(e) }));
});
api.use(appsRoutes(apps));
api.use(workflowsRoutes(workflows));
api.use(settingsRoutes());
app.use('/api', api);

// ---- static frontend (single page, no build step) ----
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- socket.io (session-cookie auth on the handshake) ----
io.use((socket, next) => {
  if (isValidSessionCookie(socket.request.headers.cookie)) next();
  else next(new Error('unauthorized'));
});

function clampDim(n: unknown, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(2, Math.min(500, Math.floor(v)));
}

io.on('connection', (socket: Socket) => {
  // Push current state so a freshly opened tab is in sync immediately.
  socket.emit('app:status', apps.list());
  socket.emit('workflow:status', workflows.list());

  socket.on('app:subscribe', (name: unknown) => {
    if (typeof name === 'string') apps.subscribe(socket, name);
  });
  socket.on('app:unsubscribe', (name: unknown) => {
    if (typeof name === 'string') apps.unsubscribe(socket, name);
  });
  socket.on('workflow:subscribe', (id: unknown) => {
    if (typeof id === 'string') workflows.subscribe(socket, id);
  });
  socket.on('workflow:unsubscribe', (id: unknown) => {
    if (typeof id === 'string') workflows.unsubscribe(socket, id);
  });

  // ---- interactive terminal: one fresh PTY per connection ----
  let term: IPty | null = null;

  const killTerm = () => {
    if (term) {
      try {
        term.kill();
      } catch {
        /* already dead */
      }
      term = null;
    }
  };

  socket.on('term:start', (opts: { cols?: number; rows?: number } | undefined) => {
    if (!ptySpawn) {
      socket.emit('term:output', '\r\n\x1b[31m[deploy-gui] node-pty is not installed on the server — Terminal unavailable.\x1b[0m\r\n');
      return;
    }
    killTerm();
    const cols = clampDim(opts?.cols, 80);
    const rows = clampDim(opts?.rows, 24);
    try {
      term = ptySpawn(resolveShell(), [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      socket.emit('term:output', `\r\n\x1b[31m[deploy-gui] failed to spawn shell: ${String(err)}\x1b[0m\r\n`);
      return;
    }
    term.onData((data) => socket.emit('term:output', data));
    term.onExit(({ exitCode }) => {
      socket.emit('term:output', `\r\n\x1b[33m[deploy-gui] shell exited (code ${exitCode}) — reconnect or reload for a new one.\x1b[0m\r\n`);
      term = null;
    });
  });

  socket.on('term:input', (data: unknown) => {
    if (term && typeof data === 'string' && data.length <= 64 * 1024) term.write(data);
  });

  socket.on('term:resize', (opts: { cols?: number; rows?: number } | undefined) => {
    if (term) {
      try {
        term.resize(clampDim(opts?.cols, 80), clampDim(opts?.rows, 24));
      } catch {
        /* pty may have just exited */
      }
    }
  });

  socket.on('disconnect', killTerm);
});

// ---- boot ----
stats.start();
apps.restore();

const PORT = Number(process.env.PORT) || 8080;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  const token = getState().accessToken;
  const line = '='.repeat(64);
  console.log(line);
  console.log('  deploy-gui is running');
  console.log(line);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Network: http://${ip}:${PORT}`);
  console.log('');
  console.log(`  Access token (paste once in the browser login screen):`);
  console.log(`  ${token}`);
  console.log('');
  console.log('  Running as ROOT inside proot-distro Debian.');
  console.log('  This GUI can run arbitrary commands with those privileges.');
  console.log('  Treat the token like a server room key.');
  console.log(line);
});
