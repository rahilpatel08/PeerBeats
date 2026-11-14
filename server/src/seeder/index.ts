import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../auth/index.js';
import type { Db } from '../db.js';
import { HttpError, wrap } from '../http.js';
import type { Tracker } from '../tracker/index.js';
import { chunkPath, sha256, type Tier } from './storage.js';

const params = z.object({ chunkId: z.string().uuid('Unknown chunk.') });
const query = z.object({ tier: z.enum(['hot', 'origin']).default('hot') });

/**
 * GET /seeder/chunks/:chunkId returns encrypted bytes, to contributors only, so they can
 * store them. Listeners get music from peers alone: the server never delivers it to them.
 */
export function seederRouter(db: Db, tracker: Tracker): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 6000, standardHeaders: true, legacyHeaders: false });

  router.get(
    '/chunks/:chunkId',
    limiter,
    requireAuth,
    wrap(async (req: AuthedRequest, res) => {
      const { chunkId } = params.parse(req.params);
      const { tier } = query.parse(req.query);
      if (!(await tracker.canSeed(req.userId!, chunkId))) {
        throw new HttpError(403, 'Music is delivered by contributors. The server only supplies contributors who are sharing.');
      }
      const { rows } = await db.query('select track_id, idx, sha256 from chunks where id = $1', [chunkId]);
      if (!rows[0]) throw new HttpError(404, 'Chunk not found.');
      const { track_id: trackId, idx, sha256: expected } = rows[0];

      let served: Tier = tier;
      if (tier === 'origin') {
        const master = fs.readFileSync(chunkPath('origin', trackId, idx));
        if (sha256(master) !== expected) throw new HttpError(500, 'The origin copy of this chunk is damaged.');
        // A listener only asks for origin after a failed hash check, so repair the hot copy now.
        const hotFile = chunkPath('hot', trackId, idx);
        const hot = fs.existsSync(hotFile) ? fs.readFileSync(hotFile) : null;
        if (!hot || sha256(hot) !== expected) {
          fs.mkdirSync(path.dirname(hotFile), { recursive: true });
          fs.writeFileSync(hotFile, master);
          console.log(`[seeder] repaired hot copy of track ${trackId} segment ${idx}`);
        }
      } else if (!fs.existsSync(chunkPath('hot', trackId, idx))) {
        served = 'origin';
      }

      const bytes = fs.readFileSync(chunkPath(served, trackId, idx));
      res.set({
        'Content-Type': 'application/octet-stream',
        // No caching: the player has to see the real stored bytes on every request.
        'Cache-Control': 'no-store',
        'X-Chunk-Tier': served,
      });
      tracker.noteSeeded(bytes.length);
      res.send(bytes);
    }),
  );

  return router;
}
