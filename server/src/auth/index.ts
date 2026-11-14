import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { HttpError, isOnThisComputer, wrap } from '../http.js';

export interface AuthedRequest extends Request {
  userId?: string;
}

export function signToken(userId: string, expiresIn: string = config.jwtExpiresIn): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn } as SignOptions);
}

/** A phone account has no password, so its sign-in lasts as long as the phone keeps it. */
const PHONE_SESSION = '365d';

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return next(new HttpError(401, 'Please log in.'));
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
    req.userId = payload.sub;
    next();
  } catch {
    next(new HttpError(401, 'Your session has expired. Please log in again.'));
  }
}

const publicUser = (u: any) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  isContributor: u.is_contributor,
  isAdmin: u.is_admin,
});

const signupBody = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
  displayName: z.string().trim().min(1, 'Enter a display name.').max(60),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

const contributorBody = z.object({ enabled: z.boolean() });

const phoneBody = z.object({
  displayName: z.string().trim().min(1, 'Enter your name.').max(60),
  role: z.enum(['listener', 'contributor']),
});

export function authRouter(db: Db): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

  router.post(
    '/auth/signup',
    limiter,
    wrap(async (req, res) => {
      const body = signupBody.parse(req.body);
      const existing = await db.query('select 1 from users where email = $1', [body.email]);
      if (existing.rows.length) throw new HttpError(409, 'An account with this email already exists.');
      const hash = await bcrypt.hash(body.password, 10);
      const { rows } = await db.query(
        'insert into users (email, password_hash, display_name) values ($1, $2, $3) returning *',
        [body.email, hash, body.displayName],
      );
      res.status(201).json({ token: signToken(rows[0].id), user: publicUser(rows[0]) });
    }),
  );

  /**
   * One tap to start on a phone: a name and a role, no email or password. The account belongs to
   * this phone. Its address is on the reserved .invalid domain, so it can never receive mail or
   * clash with a real one, and its password is random and never shown, so nobody can log in as it.
   */
  router.post(
    '/auth/phone',
    limiter,
    wrap(async (req, res) => {
      const body = phoneBody.parse(req.body);
      const email = `phone-${crypto.randomUUID()}@peerbeats.invalid`;
      const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const { rows } = await db.query(
        'insert into users (email, password_hash, display_name, is_contributor) values ($1, $2, $3, $4) returning *',
        [email, hash, body.displayName, body.role === 'contributor'],
      );
      res.status(201).json({ token: signToken(rows[0].id, PHONE_SESSION), user: publicUser(rows[0]) });
    }),
  );

  router.post(
    '/auth/login',
    limiter,
    wrap(async (req, res) => {
      const body = loginBody.parse(req.body);
      // Everyone knows the demo accounts' password, and one of them is the admin. The phone link
      // is open to the internet, so they only work on the computer running PeerBeats.
      if (body.email.endsWith('@peerbeats.test') && !isOnThisComputer(req)) {
        throw new HttpError(403, 'Demo accounts only work on the computer running PeerBeats. On a phone, choose Listener or Contributor.');
      }
      const { rows } = await db.query('select * from users where email = $1', [body.email]);
      const ok = rows[0] && (await bcrypt.compare(body.password, rows[0].password_hash));
      if (!ok) throw new HttpError(401, 'Wrong email or password.');
      res.json({ token: signToken(rows[0].id), user: publicUser(rows[0]) });
    }),
  );

  router.get(
    '/me',
    requireAuth,
    wrap(async (req: AuthedRequest, res) => {
      const { rows } = await db.query('select * from users where id = $1', [req.userId]);
      if (!rows[0]) throw new HttpError(401, 'Your account no longer exists.');
      res.json({ user: publicUser(rows[0]) });
    }),
  );

  router.post(
    '/me/contributor',
    requireAuth,
    wrap(async (req: AuthedRequest, res) => {
      const body = contributorBody.parse(req.body);
      const { rows } = await db.query('update users set is_contributor = $1 where id = $2 returning *', [
        body.enabled,
        req.userId,
      ]);
      res.json({ user: publicUser(rows[0]) });
    }),
  );

  return router;
}
