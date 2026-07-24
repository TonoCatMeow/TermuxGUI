import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

export const APPS_ROOT = process.env.DEPLOY_APPS_DIR || path.join(os.homedir(), 'deploy-apps');

/** Only allow simple directory-safe app names. */
export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)) {
    throw new Error('Invalid app name — use 1-40 chars: letters, digits, - and _ (must start alphanumeric)');
  }
  return name;
}

export function appDir(name: string): string {
  return path.join(APPS_ROOT, name);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
      } else {
        resolve((stdout + (stderr ? `\n${stderr}` : '')).trim());
      }
    });
  });
}

/** Clone a repo into the app dir, or git-pull if it's already a clone. */
export async function deployGit(repoUrl: string, name: string): Promise<{ dir: string; output: string }> {
  if (typeof repoUrl !== 'string' || !/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(repoUrl)) {
    throw new Error('Invalid git repo URL');
  }
  fs.mkdirSync(APPS_ROOT, { recursive: true });
  const dir = appDir(name);
  const output = fs.existsSync(path.join(dir, '.git'))
    ? await run('git', ['-C', dir, 'pull', '--ff-only'])
    : await run('git', ['clone', '--', repoUrl, dir]);
  return { dir, output };
}

/** Extract an uploaded zip (held in memory by multer) into the app dir. */
export function extractZip(buffer: Buffer, name: string): { dir: string; files: number } {
  if (!buffer || buffer.length < 4) throw new Error('Empty upload');
  // Quick zip magic check (PK\x03\x04) to fail fast on wrong file types.
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('Uploaded file is not a zip archive');
  const dir = appDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const zip = new AdmZip(buffer);
  // Guard against zip-slip entries before extracting.
  for (const entry of zip.getEntries()) {
    const target = path.resolve(dir, entry.entryName);
    if (!target.startsWith(path.resolve(dir) + path.sep) && target !== path.resolve(dir)) {
      throw new Error(`Unsafe path in zip: ${entry.entryName}`);
    }
  }
  zip.extractAllTo(dir, true);
  return { dir, files: zip.getEntries().length };
}

/** Write a single inline file (quick scripts) into the app dir. */
export function writeInline(name: string, filename: string, content: string): { dir: string; file: string } {
  if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(filename) || filename.includes('..')) {
    throw new Error('Invalid filename');
  }
  const dir = appDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, content ?? '', { mode: 0o755 });
  return { dir, file };
}
