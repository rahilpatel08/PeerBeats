import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { HttpError, wrap } from '../http.js';
import { ingestTrack } from '../../scripts/ingest.js';

const MAX_UPLOAD = '50mb';
const MAX_JOBS_SHOWN = 30;
export const LICENSES = ['CC0', 'CC-BY', 'CC-BY-SA', 'Own work'] as const;

const uploadQuery = z.object({
  title: z.string().trim().min(1, 'Enter a title.').max(120),
  artist: z.string().trim().min(1, 'Enter an artist.').max(120),
  album: z.string().trim().max(120).optional(),
  genre: z.string().trim().max(40).optional(),
  license: z.enum(LICENSES, { message: 'Choose a license. Only music you own or that is openly licensed can be added.' }),
});

interface Job {
  id: string;
  title: string;
  artist: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  error?: string;
  trackId?: string;
  segments?: number;
  durationSec?: number;
  at: number;
}

/**
 * Works out the format from the file's own first bytes, and ffmpeg is told to use exactly that.
 * Letting ffmpeg guess is dangerous: a file disguised as music can be a playlist that makes it
 * read other files on this computer. Anything unrecognised is refused without being opened.
 */
export function detectFormat(b: Buffer): 'mp3' | 'wav' | 'flac' | 'ogg' | 'mov' | null {
  if (b.length < 12) return null;
  const ascii = (start: number, end: number) => b.toString('latin1', start, end);
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe6) === 0xe2) return 'mp3';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(4, 8) === 'ftyp') return 'mov';
  return null;
}

export function uploadRouter(db: Db, onAdded: () => void): Router {
  const router = Router();
  const jobs: Job[] = [];
  const queue: { job: Job; file: string; dir: string; format: string; meta: z.infer<typeof uploadQuery> }[] = [];
  let working = false;

  // One at a time, so a big upload can't take over the machine.
  async function work() {
    if (working) return;
    working = true;
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { job, file, dir, format, meta } = next;
      job.status = 'processing';
      try {
        const result = await ingestTrack(db, { input: file, inputFormat: format, ...meta });
        job.status = 'done';
        job.trackId = result.trackId;
        job.segments = result.segmentCount;
        job.durationSec = result.durationSec;
        onAdded();
      } catch (err) {
        console.error('[upload] ingest failed:', err instanceof Error ? err.message : err);
        job.status = 'failed';
        job.error = 'This file couldn’t be read as audio.';
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    working = false;
  }

  router.post(
    '/tracks',
    express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD }),
    wrap(async (req, res) => {
      const meta = uploadQuery.parse(req.query);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'Choose an audio file.');
      const format = detectFormat(body);
      if (!format) throw new HttpError(415, 'That isn’t a supported audio file. Use MP3, WAV, FLAC, OGG or M4A.');
      const { rows } = await db.query('select 1 from tracks where title = $1 and artist = $2', [meta.title, meta.artist]);
      if (rows.length) throw new HttpError(409, 'A track with this title and artist already exists.');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerbeats-upload-'));
      // A name we choose: nothing from the uploader ever reaches the file system.
      const file = path.join(dir, 'upload.bin');
      fs.writeFileSync(file, body);
      const job: Job = { id: crypto.randomUUID(), title: meta.title, artist: meta.artist, status: 'queued', at: Date.now() };
      jobs.unshift(job);
      jobs.length = Math.min(jobs.length, MAX_JOBS_SHOWN);
      queue.push({ job, file, dir, format, meta });
      work().catch((err) => console.error('[upload]', err));
      res.status(202).json({ job });
    }),
  );

  router.get('/ingest', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ jobs, licenses: LICENSES });
  });

  return router;
}
