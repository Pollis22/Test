// Session auth mirroring the prelo chassis: bcrypt $2b$10 + opaque DB-backed
// session tokens in an httpOnly signed cookie.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { pool } from '../db/client.js';

export const authRouter = Router();
const COOKIE = 'prelo_session';
const SESSION_DAYS = 14;

export interface AuthedUser {
  id: string;
  shopId: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  isAdmin: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.signedCookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'UNAUTHENTICATED' });
  const r = await pool.query(
    `SELECT u.id, u.shop_id, u.email, u.role, u.is_admin
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  if (!r.rowCount) return res.status(401).json({ error: 'SESSION_EXPIRED' });
  const u = r.rows[0];
  req.user = { id: u.id, shopId: u.shop_id, email: u.email, role: u.role, isAdmin: u.is_admin };
  next();
}

export function requireRole(...roles: Array<'owner' | 'admin' | 'member'>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'FORBIDDEN' });
    next();
  };
}

authRouter.post('/login', async (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const r = await pool.query(
    'SELECT id, shop_id, email, password_hash, role, is_admin FROM users WHERE lower(email) = lower($1)',
    [body.email],
  );
  const user = r.rows[0];
  const ok = user && (await bcrypt.compare(body.password, user.password_hash));
  if (!ok) return res.status(401).json({ error: 'BAD_CREDENTIALS' });

  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO user_sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [token, user.id],
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  });
  res.json({ user: { id: user.id, email: user.email, role: user.role, shopId: user.shop_id } });
});

authRouter.post('/logout', async (req, res) => {
  const token = req.signedCookies?.[COOKIE];
  if (token) await pool.query('DELETE FROM user_sessions WHERE token = $1', [token]);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
