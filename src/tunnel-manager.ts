import { ChildProcess, spawn, spawnSync } from 'child_process';
import { Server } from 'socket.io';
import { getState, saveState } from './state';

export interface TunnelStatus {
  running: boolean;
  since: number | null;
  pid: number | null;
  tokenSaved: boolean;
  binaryAvailable: boolean;
  recentLog: string[];
}

const MAX_LOG_LINES = 100;

/**
 * Runs a *named* Cloudflare Tunnel via `cloudflared tunnel run --token <token>`.
 * The tunnel name, hostname(s) on the user's domain, and hostname->port mappings
 * are all configured ahead of time in the Cloudflare Zero Trust dashboard —
 * this app never talks to the Cloudflare API and never manages DNS.
 */
export class TunnelManager {
  private proc: ChildProcess | null = null;
  private since: number | null = null;
  private lines: string[] = [];
  private stopping = false;

  constructor(private io: Server) {}

  binaryAvailable(): boolean {
    try {
      const r = spawnSync('which', ['cloudflared'], { stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  status(): TunnelStatus {
    return {
      running: this.proc !== null,
      since: this.since,
      pid: this.proc?.pid ?? null,
      tokenSaved: !!getState().tunnelToken,
      binaryAvailable: this.binaryAvailable(),
      recentLog: this.lines.slice(-10),
    };
  }

  saveToken(token: unknown): void {
    if (typeof token !== 'string' || token.trim().length < 20 || token.trim().length > 4096) {
      throw new Error('That does not look like a Cloudflare tunnel token');
    }
    getState().tunnelToken = token.trim();
    saveState();
    this.emitStatus();
  }

  start(): void {
    if (this.proc) return;
    const token = getState().tunnelToken;
    if (!token) throw new Error('No tunnel token saved — paste one first');
    if (!this.binaryAvailable()) {
      throw new Error('cloudflared not found — install it in Termux with: pkg install cloudflared');
    }

    this.stopping = false;
    this.pushLine('[deploy-gui] starting cloudflared tunnel…');

    const proc = spawn('cloudflared', ['tunnel', 'run', '--token', token], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.since = Date.now();

    let outBuf = '';
    let errBuf = '';
    const onData = (which: 'out' | 'err') => (d: Buffer) => {
      if (which === 'out') outBuf = this.consume(outBuf + d.toString('utf8'));
      else errBuf = this.consume(errBuf + d.toString('utf8'));
    };
    proc.stdout?.on('data', onData('out'));
    proc.stderr?.on('data', onData('err'));
    proc.on('error', (err) => this.pushLine(`[deploy-gui] process error: ${String(err)}`));
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.since = null;
      this.pushLine(
        `[deploy-gui] cloudflared exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})` +
          (this.stopping ? ' — stopped by user' : ' — connection dropped')
      );
      this.stopping = false;
      this.emitStatus();
    });

    this.emitStatus();
  }

  stop(): void {
    if (!this.proc) return;
    this.stopping = true;
    this.pushLine('[deploy-gui] stopping tunnel (SIGTERM)…');
    try {
      this.proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const killer = setTimeout(() => {
      if (this.proc) {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 3000);
    killer.unref?.();
    this.emitStatus();
  }

  emitStatus(): void {
    this.io.emit('tunnel:status', this.status());
  }

  private consume(buf: string): string {
    const parts = buf.split(/\r?\n/);
    const rest = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim()) this.pushLine(line.trim());
    }
    return rest;
  }

  private pushLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
  }
}
