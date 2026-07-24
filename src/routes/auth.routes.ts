import { Router } from 'express';
import {
  checkLoginAllowed,
  clearLoginFailures,
  createSession,
  destroySession,
  recordLoginFailure,
  verifyAccessToken,
} from '../auth';

function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function authRoutes(): Router {
  const r = Router();

  r.post('/login', (req, res) => {
    const ip = clientIp(req);
    const gate = checkLoginAllowed(ip);
    if (!gate.allowed) {
      res.status(429).json({ error: `Too many attempts — try again in ${gate.retryAfterSec}s` });
      return;
    }
    const token = (req.body as { token?: unknown })?.token;
    if (!verifyAccessToken(token)) {
      recordLoginFailure(ip);
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    clearLoginFailures(ip);
    createSession(res);
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    destroySession(req, res);
    res.json({ ok: true });
  });

  return r;
}
