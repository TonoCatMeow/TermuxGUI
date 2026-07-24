import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { generateToken, getState, saveState } from './state';

export const SESSION_COOKIE = 'dg_sess';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// In-memory sessions: sid -> expiresAt. Sessions die on server restart (fine for v1).
const sessions = new Map<string, number>();

// Login rate limiting: 5 tries per 60s window, then 60s lockout.
const MAX_TRIES = 5;
const WINDOW_MS = 60_000;
const LOCKOUT_MS = 60_000;
interface Attempts {
  count: number;
  windowStart: number;
  lockedUntil: number;
}
const attempts = new Map<string, Attempts>();

function sign(sid: string): string {
  return crypto.createHmac('sha256', getState().sessionSecret).update(sid).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Burn equivalent time so length doesn't leak via timing.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function verifyAccessToken(token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false;
  return safeEqual(token, getState().accessToken);
}

export function checkLoginAllowed(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec) return { allowed: true, retryAfterSec: 0 };
  if (rec.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  if (now - rec.windowStart > WINDOW_MS) {
    attempts.delete(ip);
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    rec = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_TRIES) {
    rec.lockedUntil = now + LOCKOUT_MS;
    rec.count = 0;
    rec.windowStart = now;
  }
  attempts.set(ip, rec);
}

export function clearLoginFailures(ip: string): void {
  attempts.delete(ip);
}

export function createSession(res: Response): void {
  const sid = crypto.randomBytes(24).toString('base64url');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, `${sid}.${sign(sid)}`, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    // secure: false — plain HTTP on the LAN is a deliberate tradeoff (see README).
  });
}

export function destroySession(req: Request, res: Response): void {
  const sid = extractSid(req.headers.cookie);
  if (sid) sessions.delete(sid);
  res.clearCookie(SESSION_COOKIE);
}

export function destroyAllSessions(): void {
  sessions.clear();
}

export function regenerateAccessToken(): string {
  const token = generateToken();
  getState().accessToken = token;
  saveState();
  destroyAllSessions();
  return token;
}

function extractSid(cookieHeader: string | undefined): string | null {
  const value = parseCookieValue(cookieHeader, SESSION_COOKIE);
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const sid = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, sign(sid))) return null;
  const exp = sessions.get(sid);
  if (!exp || exp < Date.now()) {
    if (exp) sessions.delete(sid);
    return null;
  }
  return sid;
}

function parseCookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function isValidSessionCookie(cookieHeader: string | undefined): boolean {
  return extractSid(cookieHeader) !== null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isValidSessionCookie(req.headers.cookie)) {
    next();
    return;
  }
  if (req.path.startsWith('/api') || req.xhr || req.headers.accept?.includes('application/json')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.status(401).send('Unauthorized — log in first.');
}
