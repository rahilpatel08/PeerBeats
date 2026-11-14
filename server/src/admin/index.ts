import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../auth/index.js';
import type { Db } from '../db.js';
import { HttpError, wrap } from '../http.js';
import { uploadRouter } from '../catalog/upload.js';
import { revenueSummary, runPayout } from '../ledger/index.js';
import type { Tracker } from '../tracker/index.js';

export function adminRouter(db: Db, tracker: Tracker): Router {
  const router = Router();

  router.use(
    requireAuth,
    wrap(async (req: AuthedRequest, _res) => {
      const { rows } = await db.query<{ is_admin: boolean }>('select is_admin from users where id = $1', [req.userId]);
      if (!rows[0]?.is_admin) throw new HttpError(403, 'Only admins can see this.');
    }),
  );

  router.use(
    uploadRouter(db, () => {
      tracker.rebalance().catch((err) => console.error('[tracker] rebalance:', err));
    }),
  );

  router.get(
    '/network',
    wrap(async (_req, res) => {
      res.json(await tracker.snapshot());
    }),
  );

  router.get(
    '/revenue',
    wrap(async (_req, res) => {
      res.json(await revenueSummary(db));
    }),
  );

  router.post(
    '/payout/run',
    wrap(async (_req, res) => {
      res.json(await runPayout(db));
    }),
  );

  return router;
}
