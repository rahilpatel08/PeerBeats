import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../auth/index.js';
import type { Db } from '../db.js';
import { HttpError, wrap } from '../http.js';
import { allowPlay } from '../payments/access.js';

const MIME = 'audio/mp4; codecs="mp4a.40.2"';

export const publicTrack = (t: any) => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  album: t.album,
  genre: t.genre,
  durationSec: t.duration_sec,
  coverUrl: t.cover_url,
  license: t.license,
  segmentCount: t.segment_count,
  playCount: t.play_count,
});

const searchQuery = z.object({
  query: z.string().trim().max(100).optional(),
  genre: z.string().trim().max(40).optional(),
});
const idParam = z.object({ id: z.string().uuid('Unknown track.') });

export function catalogRouter(db: Db): Router {
  const router = Router();
  router.use('/tracks', requireAuth);

  router.get(
    '/tracks',
    wrap(async (req, res) => {
      const { query, genre } = searchQuery.parse(req.query);
      const where: string[] = [];
      const params: unknown[] = [];
      if (query) {
        params.push(`%${query.replace(/[%_\\]/g, '\\$&')}%`);
        const p = `$${params.length}`;
        where.push(`(title ilike ${p} or artist ilike ${p} or album ilike ${p} or genre ilike ${p})`);
      }
      if (genre) {
        params.push(genre);
        where.push(`genre = $${params.length}`);
      }
      const { rows } = await db.query(
        `select * from tracks ${where.length ? `where ${where.join(' and ')}` : ''} order by title`,
        params,
      );
      res.json({ tracks: rows.map(publicTrack) });
    }),
  );

  // Must stay above /tracks/:id, or "popular" would be read as a track id.
  router.get(
    '/tracks/popular',
    wrap(async (_req, res) => {
      const { rows } = await db.query('select * from tracks order by play_count desc, created_at, title limit 10');
      res.json({ tracks: rows.map(publicTrack) });
    }),
  );

  router.get(
    '/tracks/:id',
    wrap(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const { rows } = await db.query('select * from tracks where id = $1', [id]);
      if (!rows[0]) throw new HttpError(404, 'Track not found.');
      res.json({ track: publicTrack(rows[0]) });
    }),
  );

  /** Everything a player needs: hashes, sizes and the decryption key. Listeners only. */
  router.get(
    '/tracks/:id/manifest',
    wrap(async (req: AuthedRequest, res) => {
      const { id } = idParam.parse(req.params);
      const { rows: tracks } = await db.query('select * from tracks where id = $1', [id]);
      if (!tracks[0]) throw new HttpError(404, 'Track not found.');
      // The manifest carries the decryption key, so this is the door that payment guards.
      const prefetch = req.query.prefetch === '1';
      if (!(await allowPlay(db, req.userId!, id, !prefetch))) {
        throw new HttpError(402, 'You need a plan to listen.');
      }
      const { rows: chunks } = await db.query(
        'select id, idx, sha256, size_bytes, start_time_sec from chunks where track_id = $1 order by idx',
        [id],
      );
      const { rows: keys } = await db.query<{ aes_key: Uint8Array }>(
        'select aes_key from track_keys where track_id = $1',
        [id],
      );
      if (!keys[0]) throw new HttpError(500, 'This track has no key.');

      // Queue pre-fetching reads the manifest too, and must not count as a play.
      if (!prefetch) {
        await db.query('update tracks set play_count = play_count + 1 where id = $1', [id]);
      }

      res.set('Cache-Control', 'no-store');
      res.json({
        track: publicTrack(tracks[0]),
        mime: MIME,
        key: Buffer.from(keys[0].aes_key).toString('base64'),
        chunks: chunks.map((c: any) => ({
          id: c.id,
          idx: c.idx,
          sha256: c.sha256,
          size: c.size_bytes,
          start: c.start_time_sec === null ? null : Number(c.start_time_sec),
        })),
      });
    }),
  );

  return router;
}
