import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { Server, Socket } from 'socket.io';
import { getState, saveState, Workflow, WorkflowRun } from './state';
import { resolveShell } from './shell';

const HISTORY_LIMIT = 20;
const room = (id: string) => `wf:${id}`;

interface Running {
  proc: ChildProcess;
  runId: string;
  startedAt: number;
}

export interface WorkflowView extends Workflow {
  running: boolean;
  runId: string | null;
}

export class WorkflowsManager {
  private running = new Map<string, Running>();

  constructor(private io: Server) {}

  list(): WorkflowView[] {
    return getState().workflows.map((wf) => {
      const r = this.running.get(wf.id);
      return { ...wf, running: !!r, runId: r?.runId ?? null };
    });
  }

  create(name: string, command: string, cwd?: string): WorkflowView {
    if (!name || typeof name !== 'string') throw new Error('Workflow name required');
    if (!command || typeof command !== 'string') throw new Error('Command required');
    const wf: Workflow = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name.trim().slice(0, 80),
      command,
      cwd: cwd && cwd.trim() ? cwd.trim() : undefined,
      history: [],
    };
    getState().workflows.push(wf);
    saveState();
    this.emitStatus();
    return { ...wf, running: false, runId: null };
  }

  delete(id: string): boolean {
    const r = this.running.get(id);
    if (r) {
      try {
        r.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.running.delete(id);
    }
    const state = getState();
    const before = state.workflows.length;
    state.workflows = state.workflows.filter((w) => w.id !== id);
    if (state.workflows.length !== before) {
      saveState();
      this.emitStatus();
      return true;
    }
    return false;
  }

  run(id: string): { runId: string } {
    const wf = getState().workflows.find((w) => w.id === id);
    if (!wf) throw new Error('Workflow not found');
    if (this.running.has(id)) throw new Error('Workflow already running');

    const runId = crypto.randomBytes(6).toString('hex');
    const startedAt = Date.now();

    const proc = spawn(resolveShell(), ['-c', wf.command], {
      cwd: wf.cwd || os.homedir(),
      env: { ...process.env, WORKFLOW_NAME: wf.name, WORKFLOW_RUN_ID: runId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.running.set(id, { proc, runId, startedAt });
    this.emitToRoom(id, { id, runId, data: `\n[deploy-gui] run ${runId} started at ${new Date(startedAt).toISOString()}\n` });
    this.emitStatus();

    proc.stdout?.on('data', (d: Buffer) => this.emitToRoom(id, { id, runId, data: d.toString('utf8') }));
    proc.stderr?.on('data', (d: Buffer) => this.emitToRoom(id, { id, runId, data: d.toString('utf8') }));
    proc.on('error', (err) =>
      this.emitToRoom(id, { id, runId, data: `\n[deploy-gui] process error: ${String(err)}\n` })
    );
    proc.on('close', (code) => {
      this.running.delete(id);
      const durationMs = Date.now() - startedAt;
      const entry: WorkflowRun = { ts: startedAt, exitCode: code, durationMs };
      wf.history.push(entry);
      if (wf.history.length > HISTORY_LIMIT) wf.history.splice(0, wf.history.length - HISTORY_LIMIT);
      saveState();
      this.emitToRoom(id, {
        id,
        runId,
        data: `\n[deploy-gui] exited with code ${code ?? 'null'} after ${(durationMs / 1000).toFixed(1)}s\n`,
        exit: true,
        exitCode: code,
        durationMs,
      });
      this.emitStatus();
    });

    return { runId };
  }

  subscribe(socket: Socket, id: string): void {
    void socket.join(room(id));
    const wf = getState().workflows.find((w) => w.id === id);
    socket.emit('workflow:history', { id, history: wf ? wf.history : [] });
  }

  unsubscribe(socket: Socket, id: string): void {
    void socket.leave(room(id));
  }

  emitStatus(): void {
    this.io.emit('workflow:status', this.list());
  }

  private emitToRoom(id: string, payload: Record<string, unknown>): void {
    this.io.to(room(id)).emit('workflow:log', payload);
  }
}
