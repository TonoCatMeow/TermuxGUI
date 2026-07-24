import { execFileSync } from 'child_process';
import fs from 'fs';

/**
 * Shell resolution for proot-distro Debian (running as root).
 *
 * Inside proot Debian, /bin/bash exists at the standard FHS path and
 * $SHELL is normally /bin/bash. We still resolve defensively instead of
 * hardcoding: $SHELL -> `which bash` -> /bin/bash -> /usr/bin/bash -> /bin/sh.
 * (The old Termux $PREFIX path is kept as a last-ditch fallback in case this
 * ever runs in a plain Termux shell instead of the proot container.)
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

  candidates.push('/bin/bash', '/usr/bin/bash', '/bin/sh');

  if (process.env.PREFIX) {
    candidates.push(`${process.env.PREFIX}/bin/bash`, `${process.env.PREFIX}/bin/sh`);
  }

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
