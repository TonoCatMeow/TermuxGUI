import { execFileSync } from 'child_process';
import fs from 'fs';

/**
 * Termux-aware shell resolution.
 *
 * Do NOT hardcode /bin/bash — on Termux the shell lives under $PREFIX
 * (e.g. /data/data/com.termux/files/usr/bin/bash) and /bin/bash does not exist.
 * Resolution order: $SHELL -> `which bash` -> $PREFIX/bin/bash -> $PREFIX/bin/sh
 * -> /bin/bash -> /bin/sh -> bare "sh" (PATH lookup).
 */
let cached: string | null = null;

export function resolveShell(): string {
  if (cached) return cached;

  const candidates: string[] = [];

  if (process.env.SHELL) candidates.push(process.env.SHELL);

  try {
    const found = execFileSync('which', ['bash'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (found) candidates.push(found);
  } catch {
    /* which not available or bash not found */
  }

  if (process.env.PREFIX) {
    candidates.push(`${process.env.PREFIX}/bin/bash`, `${process.env.PREFIX}/bin/sh`);
  }

  candidates.push('/bin/bash', '/bin/sh');

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        cached = c;
        return c;
      }
    } catch {
      /* keep looking */
    }
  }

  cached = 'sh';
  return cached;
}
