import { Router } from 'express';
import fs from 'fs';
import multer from 'multer';
import { AppsManager } from '../apps-manager';
import { appDir, deployGit, extractZip, sanitizeName, writeInline } from '../deploy';
import { AppConfig } from '../state';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB zip cap
});

function err(res: { status: (n: number) => { json: (b: unknown) => void } }, e: unknown, code = 400): void {
  res.status(code).json({ error: e instanceof Error ? e.message : String(e) });
}

export function appsRoutes(apps: AppsManager): Router {
  const r = Router();

  r.get('/apps', (_req, res) => {
    res.json(apps.list());
  });

  // JSON create: method = "git" | "inline"
  r.post('/apps', async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const name = sanitizeName(body.name);
      const method = body.method;
      const command = String(body.command ?? '').trim();
      if (!command) throw new Error('Start command required');
      const autoStart = body.autoStart === true || body.autoStart === 'true';

      let cwd: string;
      let repoUrl: string | undefined;
      let deployNote = '';

      if (method === 'git') {
        repoUrl = String(body.repoUrl ?? '').trim();
        const result = await deployGit(repoUrl, name);
        cwd = result.dir;
        deployNote = result.output;
      } else if (method === 'inline') {
        const result = writeInline(name, String(body.filename ?? ''), String(body.content ?? ''));
        cwd = result.dir;
        deployNote = `wrote ${result.file}`;
      } else {
        throw new Error('method must be "git" or "inline" (use /api/apps/upload for zips)');
      }

      const customCwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null;
      const cfg: AppConfig = {
        name,
        method,
        command,
        cwd: customCwd || cwd,
        repoUrl,
        autoStart,
        createdAt: Date.now(),
      };
      apps.addApp(cfg);
      res.json({ ok: true, app: cfg, deployNote });
    } catch (e) {
      err(res, e);
    }
  });

  // Multipart create: method = "upload" (zip file in field "file")
  r.post('/apps/upload', upload.single('file'), (req, res) => {
    try {
      const name = sanitizeName(req.body?.name);
      const command = String(req.body?.command ?? '').trim();
      if (!command) throw new Error('Start command required');
      if (!req.file) throw new Error('No zip file uploaded');
      const autoStart = req.body?.autoStart === 'true' || req.body?.autoStart === 'on';

      const result = extractZip(req.file.buffer, name);
      const customCwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim() ? req.body.cwd.trim() : null;
      const cfg: AppConfig = {
        name,
        method: 'upload',
        command,
        cwd: customCwd || result.dir,
        autoStart,
        createdAt: Date.now(),
      };
      apps.addApp(cfg);
      res.json({ ok: true, app: cfg, deployNote: `extracted ${result.files} entries to ${result.dir}` });
    } catch (e) {
      err(res, e);
    }
  });

  r.post('/apps/:name/start', (req, res) => {
    try {
      apps.start(req.params.name);
      res.json({ ok: true });
    } catch (e) {
      err(res, e, 404);
    }
  });

  r.post('/apps/:name/stop', (req, res) => {
    apps.stop(req.params.name);
    res.json({ ok: true });
  });

  r.post('/apps/:name/restart', (req, res) => {
    try {
      apps.restart(req.params.name);
      res.json({ ok: true });
    } catch (e) {
      err(res, e, 404);
    }
  });

  r.delete('/apps/:name', (req, res) => {
    try {
      const name = sanitizeName(req.params.name);
      if (!apps.getConfig(name)) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      apps.removeApp(name);
      if (req.query.deleteFiles === '1' || req.query.deleteFiles === 'true') {
        fs.rmSync(appDir(name), { recursive: true, force: true });
      }
      res.json({ ok: true });
    } catch (e) {
      err(res, e);
    }
  });

  return r;
}
