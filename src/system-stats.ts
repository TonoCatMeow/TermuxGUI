import os from 'os';
import si from 'systeminformation';
import { Server } from 'socket.io';

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
}

export interface HealthPayload {
  ts: number;
  cpuPercent: number;
  ram: { used: number; total: number; percent: number };
  storage: { used: number; total: number; percent: number; mount: string };
  uptimeSec: number;
  requests: number;
  processes: ProcessInfo[];
}

const INTERVAL_MS = 2500;
const TOP_N = 6;

async function gather(getRequests: () => number): Promise<HealthPayload> {
  let cpuPercent = 0;
  let ram = { used: 0, total: os.totalmem(), percent: 0 };
  let storage = { used: 0, total: 0, percent: 0, mount: '/' };
  let processes: ProcessInfo[] = [];

  try {
    const load = await si.currentLoad();
    cpuPercent = Math.round(load.currentLoad * 10) / 10;
  } catch {
    const avg = os.loadavg()[0];
    cpuPercent = Math.min(100, Math.round((avg / Math.max(1, os.cpus().length)) * 1000) / 10);
  }

  try {
    const mem = await si.mem();
    ram = {
      used: mem.used,
      total: mem.total,
      percent: mem.total > 0 ? Math.round((mem.used / mem.total) * 1000) / 10 : 0,
    };
  } catch {
    const total = os.totalmem();
    const used = total - os.freemem();
    ram = { used, total, percent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0 };
  }

  try {
    const fses = await si.fsSize();
    if (fses.length > 0) {
      const home = os.homedir();
      const pick =
        fses.find((f) => f.mount && home.startsWith(f.mount) && f.size > 0) ||
        [...fses].filter((f) => f.size > 0).sort((a, b) => b.size - a.size)[0];
      if (pick) {
        storage = {
          used: pick.used,
          total: pick.size,
          percent: Math.round(pick.use * 10) / 10,
          mount: pick.mount,
        };
      }
    }
  } catch {
    /* storage unavailable */
  }

  try {
    const procs = await si.processes();
    processes = procs.list
      .filter((p) => p.pid > 0)
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, TOP_N)
      .map((p) => ({
        pid: p.pid,
        name: p.name || p.command || '?',
        cpu: Math.round(p.cpu * 10) / 10,
        mem: Math.round(p.mem * 10) / 10,
      }));
  } catch {
    /* process list unavailable */
  }

  return {
    ts: Date.now(),
    cpuPercent,
    ram,
    storage,
    uptimeSec: os.uptime(),
    requests: getRequests(),
    processes,
  };
}

export class StatsEmitter {
  private timer: NodeJS.Timeout | null = null;

  constructor(private io: Server, private getRequests: () => number) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): Promise<HealthPayload> {
    return gather(this.getRequests);
  }

  private async tick(): Promise<void> {
    try {
      const payload = await gather(this.getRequests);
      this.io.emit('health:update', payload);
    } catch {
      /* never let stats kill the loop */
    }
  }
}
