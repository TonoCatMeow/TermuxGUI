import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type DeployMethod = 'git' | 'upload' | 'inline';

export interface AppConfig {
  name: string;
  method: DeployMethod;
  command: string;
  cwd: string;
  repoUrl?: string;
  autoStart: boolean;
  /** Serve cwd over HTTP with the built-in static server instead of running a command. */
  static?: boolean;
  /** Assigned port: static sites listen on it; for command apps it's exported as $PORT. */
  port?: number;
  createdAt: number;
}

export interface WorkflowRun {
  ts: number;
  exitCode: number | null;
  durationMs: number;
}

export interface Workflow {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  history: WorkflowRun[];
}

export interface StateData {
  accessToken: string;
  sessionSecret: string;
  apps: AppConfig[];
  workflows: Workflow[];
}

export const DATA_DIR = process.env.DEPLOY_GUI_HOME || path.join(os.homedir(), '.deploy-gui');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

export function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

let state: StateData | null = null;

export function loadState(): StateData {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let loaded: StateData | null = null;
  if (fs.existsSync(STATE_FILE)) {
    try {
      loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as StateData;
    } catch {
      // Corrupt state file — back it up rather than destroying it.
      try {
        fs.copyFileSync(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}.bak`);
      } catch {
        /* ignore */
      }
    }
  }

  if (loaded && typeof loaded.accessToken === 'string' && typeof loaded.sessionSecret === 'string') {
    state = {
      accessToken: loaded.accessToken,
      sessionSecret: loaded.sessionSecret,
      apps: Array.isArray(loaded.apps) ? loaded.apps : [],
      workflows: Array.isArray(loaded.workflows) ? loaded.workflows : [],
    };
  } else {
    state = {
      accessToken: generateToken(),
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      apps: [],
      workflows: [],
    };
    saveState();
  }
  return state;
}

export function getState(): StateData {
  if (!state) throw new Error('State not loaded — call loadState() first');
  return state;
}

export function saveState(): void {
  if (!state) return;
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
  try {
    fs.chmodSync(STATE_FILE, 0o600);
  } catch {
    /* best effort */
  }
}
