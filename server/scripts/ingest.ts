/**
 * Audio -> encrypted segments -> catalog.
 *   npm run ingest -- ./seed/track.mp3 --title "Name" --artist "Name" --license CC-BY
 * Stop the server first when using the built-in database.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { openDb, type Db } from '../src/db.js';
import { config } from '../src/config.js';
import { coverDir, sha256, writeChunk } from '../src/seeder/storage.js';
import { coverSvg } from './cover.js';

export interface IngestOptions {
  input: string;
  /** Tell ffmpeg the format instead of letting it guess. Required for anything uploaded. */
  inputFormat?: string;
  title: string;
  artist: string;
  album?: string;
  genre?: string;
  license: string;
}

export interface IngestResult {
  trackId: string;
  segmentCount: number;
  totalBytes: number;
  durationSec: number;
}

function runFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg is not available on this platform.'));
    const child = spawn(ffmpegPath as unknown as string, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', (d) => (log += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (exit ${code}):\n${log}`));
    });
  });
}

/** Reads each segment's real start time and duration out of the DASH SegmentTimeline. */
export function parseTimeline(mpd: string): { starts: number[]; duration: number } {
  const timescale = Number(/timescale="(\d+)"/.exec(mpd)?.[1]);
  if (!timescale) throw new Error('Could not read the timescale from the DASH manifest.');
  const starts: number[] = [];
  let cursor = 0;
  for (const match of mpd.matchAll(/<S\b([^>]*)\/>/g)) {
    const attr = (name: string) => {
      const value = new RegExp(`\\b${name}="(\\d+)"`).exec(match[1])?.[1];
      return value === undefined ? undefined : Number(value);
    };
    const t = attr('t');
    if (t !== undefined) cursor = t;
    const d = attr('d');
    if (d === undefined) throw new Error('A timeline entry has no duration.');
    for (let i = 0; i <= (attr('r') ?? 0); i++) {
      starts.push(cursor / timescale);
      cursor += d;
    }
  }
  if (!starts.length) throw new Error('The DASH manifest lists no segments.');
  return { starts, duration: cursor / timescale };
}

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  // iv + ciphertext + tag: the layout WebCrypto expects when it decrypts in the browser.
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

export async function ingestTrack(db: Db, opts: IngestOptions): Promise<IngestResult> {
  if (!fs.existsSync(opts.input)) throw new Error(`File not found: ${opts.input}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'peerbeats-ingest-'));
  let trackId: string | null = null;
  try {
    await runFfmpeg(
      ['-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', ...(opts.inputFormat ? ['-f', opts.inputFormat] : []), '-i', path.resolve(opts.input), '-vn', '-map_metadata', '-1',
       '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'dash', '-seg_duration', '5',
       '-init_seg_name', 'init.m4s', '-media_seg_name', 'seg_$Number$.m4s', 'out.mpd'],
      work,
    );
    const { starts, duration } = parseTimeline(fs.readFileSync(path.join(work, 'out.mpd'), 'utf8'));
    const files = ['init.m4s', ...starts.map((_, i) => `seg_${i + 1}.m4s`)];
    const key = crypto.randomBytes(32);
    const encrypted = files.map((f) => encrypt(fs.readFileSync(path.join(work, f)), key));

    const { rows } = await db.query<{ id: string }>(
      `insert into tracks (title, artist, album, genre, duration_sec, license, segment_count, init_segment_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [opts.title, opts.artist, opts.album ?? null, opts.genre ?? null, Math.round(duration), opts.license,
       starts.length, sha256(encrypted[0])],
    );
    trackId = rows[0].id;

    fs.mkdirSync(coverDir(), { recursive: true });
    fs.writeFileSync(path.join(coverDir(), `${trackId}.svg`), coverSvg(`${opts.title}|${opts.artist}`, opts.genre));
    await db.query('update tracks set cover_url = $1 where id = $2', [`/covers/${trackId}.svg`, trackId]);
    await db.query('insert into track_keys (track_id, aes_key) values ($1, $2)', [trackId, key]);

    let totalBytes = 0;
    for (let idx = 0; idx < encrypted.length; idx++) {
      const bytes = encrypted[idx];
      writeChunk(trackId, idx, bytes);
      totalBytes += bytes.length;
      await db.query(
        'insert into chunks (track_id, idx, sha256, size_bytes, start_time_sec) values ($1, $2, $3, $4, $5)',
        [trackId, idx, sha256(bytes), bytes.length, idx === 0 ? null : starts[idx - 1]],
      );
    }
    return { trackId, segmentCount: starts.length, totalBytes, durationSec: Math.round(duration) };
  } catch (err) {
    if (trackId) {
      await db.query('delete from tracks where id = $1', [trackId]);
      for (const tier of ['hot', 'origin']) {
        fs.rmSync(path.join(config.storageDir, tier, trackId), { recursive: true, force: true });
      }
    }
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  let input = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i] ?? '';
    else input = argv[i];
  }
  return { input, flags };
}

async function main() {
  const { input, flags } = parseArgs(process.argv.slice(2));
  if (!input || !flags.title || !flags.artist || !flags.license) {
    console.error('Usage: npm run ingest -- <file> --title "..." --artist "..." --license CC-BY [--album "..."] [--genre "..."]');
    process.exit(1);
  }
  // npm runs this script from server/, so resolve the path from where you typed the command.
  const resolved = path.resolve(process.env.INIT_CWD ?? process.cwd(), input);
  const db = await openDb();
  try {
    const result = await ingestTrack(db, {
      input: resolved,
      title: flags.title,
      artist: flags.artist,
      album: flags.album,
      genre: flags.genre,
      license: flags.license,
    });
    console.log(`Track id:      ${result.trackId}`);
    console.log(`Segments:      ${result.segmentCount} media + 1 init`);
    console.log(`Total size:    ${(result.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Duration:      ${result.durationSec}s`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
