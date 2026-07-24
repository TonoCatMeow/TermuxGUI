import { ChildProcess, spawn } from 'child_process';
import { Server, Socket } from 'socket.io';
import { AppConfig, getState, saveState } from './state';
import { resolveShell } from './shell';

export type AppStatus = 'running' | 'stopped' | 'crashed';

interface Runtime {
  proc: ChildProcess | null;
  status: AppStatus;
  startedAt: number | null;
  restarts: number;
  stopping: boolean;
  restartAfterExit: boolean;
  log: string[];
}

export interface AppView extends AppConfig {
  status: AppStatus;
  uptimeMs: number;
  restarts: number;
  pid: number | null;
}

const MAX_LOG_CHUNKS = 500;
const room = (name: string) => `app:${name}`;

export class AppsManager {
  private rt = new Map<string, Runtime>();

  constructor(private io: Server) {}

  private ensureRt(name: string): Runtime {
    let r = this.rt.get(name);
    if (!r) {
      r = {
        proc: null,
        status: 'stopped',
        startedAt: null,
        restarts: 0,
        stopping: false,
        restartAfterExit: false,
        log: [],
      };
      this.rt.set(name, r);
    }
    return r;
  }

  list(): AppView[] {
    return getState().apps.map((cfg) => {
      const r = this.ensureRt(cfg.name);
      return {
        ...cfg,
        status: r.status,
        uptimeMs: r.startedAt ? Date.now() - r.startedAt : 0,
        restarts: r.restarts,
        pid: r.proc?.pid ?? null,
      };
    });
  }

  getConfig(name: string): AppConfig | undefined {
    return getState().apps.find((a) => a.name === name);
  }

  addApp(cfg: AppConfig): void {
    const state = getState();
    if (state.apps.some((a) => a.name === cfg.name)) {
      throw new Error(`App "${cfg.name}" already exists`);
    }
    state.apps.push(cfg);
    saveState();
    this.ensureRt(cfg.name);
    this.emitStatus();
    if (cfg.autoStart) {
      try {
        this.start(cfg.name);
      } catch (err) {
        this.appendLog(cfg.name, `\n[deploy-gui] auto-start failed: ${String(err)}\n`);
      }
    }
  }

  removeApp(name: string): void {
    this.stop(name);
    const state = getState();
    state.apps = state.apps.filter((a) => a.name !== name);
    saveState();
    this.rt.delete(name);
    this.emitStatus();
  }

  start(name: string): void {
    const cfg = this.getConfig(name);
    if (!cfg) throw new Error(`Unknown app "${name}"`);
    const r = this.ensureRt(name);
    if (r.proc) return; // already running

    r.stopping = false;
    r.restartAfterExit = false;

    let proc: ChildProcess;
    try {
      proc = spawn(resolveShell(), ['-c', cfg.command], {
        cwd: cfg.cwd,
        env: { ...process.env, APP_NAME: name },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      r.status = 'crashed';
      this.appendLog(name, `[deploy-gui] spawn failed: ${String(err)}\n`);
      this.emitStatus();
      throw err;
    }

    r.proc = proc;
    r.status = 'running';
    r.startedAt = Date.now();
    this.appendLog(name, `\n[deploy-gui] started (pid ${proc.pid}) at ${new Date().toISOString()}\n`);

    proc.stdout?.on('data', (d: Buffer) => this.appendLog(name, d.toString('utf8')));
    proc.stderr?.on('data', (d: Buffer) => this.appendLog(name, d.toString('utf8')));
    proc.on('error', (err) => this.appendLog(name, `\n[deploy-gui] process error: ${String(err)}\n`));
    proc.on('exit', (code, signal) => {
      const wasStopping = r.stopping;
      const wantsRestart = r.restartAfterExit;
      r.proc = null;
      r.startedAt = null;
      r.stopping = false;
      r.restartAfterExit = false;
      r.status = wasStopping ? 'stopped' : 'crashed';
      this.appendLog(
        name,
        `\n[deploy-gui] exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})\n`
      );
      this.emitStatus();
      if (wantsRestart) {
        r.restarts += 1;
        try {
          this.start(name);
        } catch {
          /* already logged */
        }
      }
    });

    this.emitStatus();
  }

  stop(name: string): void {
    const r = this.ensureRt(name);
    const proc = r.proc;
    if (!proc) {
      if (r.status !== 'stopped') {
        r.status = 'stopped';
        r.startedAt = null;
        this.emitStatus();
      }
      return;
    }
    r.stopping = true;
    r.restartAfterExit = false;
    this.appendLog(name, '\n[deploy-gui] stopping (SIGTERM)\n');
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    const killer = setTimeout(() => {
      if (r.proc) {
        this.appendLog(name, '\n[deploy-gui] still alive — SIGKILL\n');
        try {
          r.proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 3000);
    killer.unref?.();
  }

  restart(name: string): void {
    const r = this.ensureRt(name);
    if (r.proc) {
      r.restartAfterExit = true;
      this.stopInternalForRestart(name, r);
    } else {
      r.restarts += 1;
      this.start(name);
    }
  }

  private stopInternalForRestart(name: string, r: Runtime): void {
    r.stopping = true;
    r.restartAfterExit = true; // stop() clears it, so re-arm after
    this.appendLog(name, '\n[deploy-gui] restarting…\n');
    try {
      r.proc?.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const killer = setTimeout(() => {
      if (r.proc) {
        try {
          r.proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 3000);
    killer.unref?.();
  }

  subscribe(socket: Socket, name: string): void {
    const r = this.ensureRt(name);
    void socket.join(room(name));
    socket.emit('app:log', { name, data: r.log.join(''), replay: true });
  }

  unsubscribe(socket: Socket, name: string): void {
    void socket.leave(room(name));
  }

  restore(): void {
    for (const cfg of getState().apps) {
      const r = this.ensureRt(cfg.name);
      r.status = 'stopped'; // processes never survive a server restart
      if (cfg.autoStart) {
        try {
          this.start(cfg.name);
        } catch {
          /* logged in appendLog */
        }
      }
    }
    this.emitStatus();
  }

  emitStatus(): void {
    this.io.emit('app:status', this.list());
  }

  private appendLog(name: string, data: string): void {
    const r = this.ensureRt(name);
    r.log.push(data);
    if (r.log.length > MAX_LOG_CHUNKS) r.log.splice(0, r.log.length - MAX_LOG_CHUNKS);
    this.io.to(room(name)).emit('app:log', { name, data });
  }
}
