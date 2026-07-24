import { spawnSync } from 'child_process';
import os from 'os';
import { Router } from 'express';
import { createSession, regenerateAccessToken } from '../auth';
import { resolveShell } from '../shell';
import { DATA_DIR, STATE_FILE } from '../state';

function whichOk(bin: string): boolean {
  try {
    return spawnSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;
  } catch {
    return false;
  }
}

function sshdRunning(): boolean {
  try {
    return spawnSync('pgrep', ['-x', 'sshd'], { stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;
  } catch {
    return false;
  }
}

export function settingsRoutes(): Router {
  const r = Router();

  r.get('/settings', (_req, res) => {
    const sshdInstalled = whichOk('sshd');
    let user = 'unknown';
    try {
      user = os.userInfo().username;
    } catch {
      /* ignore */
    }
    res.json({
      shell: resolveShell(),
      user,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      home: os.homedir(),
      dataDir: DATA_DIR,
      stateFile: STATE_FILE,
      sshd: {
        installed: sshdInstalled,
        running: sshdInstalled ? sshdRunning() : false,
      },
    });
  });

  r.post('/settings/regenerate-token', (_req, res) => {
    // Regenerating invalidates every session, including this one — so hand the
    // caller a fresh session alongside the new token (shown once in the UI).
    const token = regenerateAccessToken();
    createSession(res);
    res.json({ ok: true, token });
  });

  return r;
}
