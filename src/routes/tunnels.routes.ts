import { Router } from 'express';
import { TunnelManager } from '../tunnel-manager';

export function tunnelsRoutes(tunnel: TunnelManager): Router {
  const r = Router();

  r.get('/tunnel', (_req, res) => {
    res.json(tunnel.status());
  });

  r.post('/tunnel/token', (req, res) => {
    try {
      tunnel.saveToken((req.body as { token?: unknown })?.token);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.post('/tunnel/start', (_req, res) => {
    try {
      tunnel.start();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.post('/tunnel/stop', (_req, res) => {
    tunnel.stop();
    res.json({ ok: true });
  });

  return r;
}
