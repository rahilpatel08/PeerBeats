import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../auth/index.js';
import { publicTrack } from '../catalog/index.js';
import type { Db } from '../db.js';
import { HttpError, wrap } from '../http.js';

const MAX_PLAYLISTS = 200;

const uuid = z.string().uuid('Not found.');
const trackParam = z.object({ trackId: uuid });
const playlistParam = z.object({ id: uuid });
const playlistTrackParam = z.object({ id: uuid, trackId: uuid });
const nameBody = z.object({ name: z.string().trim().min(1, 'Give the playlist a name.').max(80, 'That name is too long.') });
const addBody = z.object({ trackId: uuid });

export function libraryRouter(db: Db): Router {
  const router = Router();
  router.use(['/likes', '/playlists'], requireAuth);

  async function requireTrack(trackId: string) {
    const { rows } = await db.query('select 1 from tracks where id = $1', [trackId]);
    if (!rows.length) throw new HttpError(404, 'Track not found.');
  }

  /** Someone else's playlist looks exactly like one that doesn't exist. */
  async function requireOwnPlaylist(id: string, userId: string) {
    const { rows } = await db.query<{ id: string; name: string }>('select id, name from playlists where id = $1 and user_id = $2', [id, userId]);
    if (!rows[0]) throw new HttpError(404, 'Playlist not found.');
    return rows[0];
  }

  router.get(
    '/likes',
    wrap(async (req: AuthedRequest, res) => {
      const { rows } = await db.query(
        `select t.* from liked_tracks l join tracks t on t.id = l.track_id where l.user_id = $1 order by l.created_at desc`,
        [req.userId],
      );
      res.json({ tracks: rows.map(publicTrack) });
    }),
  );

  router.put(
    '/likes/:trackId',
    wrap(async (req: AuthedRequest, res) => {
      const { trackId } = trackParam.parse(req.params);
      await requireTrack(trackId);
      await db.query('insert into liked_tracks (user_id, track_id) values ($1, $2) on conflict do nothing', [req.userId, trackId]);
      res.json({ liked: true });
    }),
  );

  router.delete(
    '/likes/:trackId',
    wrap(async (req: AuthedRequest, res) => {
      const { trackId } = trackParam.parse(req.params);
      await db.query('delete from liked_tracks where user_id = $1 and track_id = $2', [req.userId, trackId]);
      res.json({ liked: false });
    }),
  );

  router.get(
    '/playlists',
    wrap(async (req: AuthedRequest, res) => {
      const { rows } = await db.query<{ id: string; name: string; track_count: string; track_ids: string[] | null }>(
        `select p.id, p.name, count(pt.track_id) as track_count, array_agg(pt.track_id) filter (where pt.track_id is not null) as track_ids
         from playlists p left join playlist_tracks pt on pt.playlist_id = p.id
         where p.user_id = $1 group by p.id, p.name order by p.name`,
        [req.userId],
      );
      res.json({ playlists: rows.map((p) => ({ id: p.id, name: p.name, trackCount: Number(p.track_count), trackIds: p.track_ids ?? [] })) });
    }),
  );

  router.post(
    '/playlists',
    wrap(async (req: AuthedRequest, res) => {
      const { name } = nameBody.parse(req.body);
      const { rows: count } = await db.query<{ n: string }>('select count(*) as n from playlists where user_id = $1', [req.userId]);
      if (Number(count[0].n) >= MAX_PLAYLISTS) throw new HttpError(400, 'You have reached the playlist limit.');
      const { rows } = await db.query<{ id: string; name: string }>('insert into playlists (user_id, name) values ($1, $2) returning id, name', [req.userId, name]);
      res.status(201).json({ playlist: { ...rows[0], trackCount: 0, trackIds: [] } });
    }),
  );

  router.get(
    '/playlists/:id',
    wrap(async (req: AuthedRequest, res) => {
      const { id } = playlistParam.parse(req.params);
      const playlist = await requireOwnPlaylist(id, req.userId!);
      const { rows } = await db.query(
        `select t.* from playlist_tracks pt join tracks t on t.id = pt.track_id where pt.playlist_id = $1 order by pt.position`,
        [id],
      );
      res.json({ playlist: { ...playlist, tracks: rows.map(publicTrack) } });
    }),
  );

  router.delete(
    '/playlists/:id',
    wrap(async (req: AuthedRequest, res) => {
      const { id } = playlistParam.parse(req.params);
      await requireOwnPlaylist(id, req.userId!);
      await db.query('delete from playlists where id = $1', [id]);
      res.json({ deleted: true });
    }),
  );

  router.post(
    '/playlists/:id/tracks',
    wrap(async (req: AuthedRequest, res) => {
      const { id } = playlistParam.parse(req.params);
      const { trackId } = addBody.parse(req.body);
      await requireOwnPlaylist(id, req.userId!);
      await requireTrack(trackId);
      await db.query(
        `insert into playlist_tracks (playlist_id, track_id, position)
         select $1, $2, coalesce(max(position), 0) + 1 from playlist_tracks where playlist_id = $1
         on conflict do nothing`,
        [id, trackId],
      );
      res.status(201).json({ added: true });
    }),
  );

  router.delete(
    '/playlists/:id/tracks/:trackId',
    wrap(async (req: AuthedRequest, res) => {
      const { id, trackId } = playlistTrackParam.parse(req.params);
      await requireOwnPlaylist(id, req.userId!);
      await db.query('delete from playlist_tracks where playlist_id = $1 and track_id = $2', [id, trackId]);
      res.json({ removed: true });
    }),
  );

  return router;
}
