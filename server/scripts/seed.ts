/** Creates the demo users and generates, then ingests, the 20 original tracks. Safe to re-run. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { payWithTestPortal } from '../src/payments/index.js';
import { chunkPath } from '../src/seeder/storage.js';
import { ingestTrack } from './ingest.js';
import { renderTrack, type SynthSpec } from './synth.js';

interface SeedTrack extends SynthSpec {
  title: string;
  artist: string;
  album: string;
  license: string;
}

const DEMO_PASSWORD = 'demo1234';
const DEMO_USERS = [
  { email: 'listener@peerbeats.test', name: 'Listener 1', contributor: false, admin: false, plan: true },
  { email: 'listener2@peerbeats.test', name: 'Listener 2', contributor: false, admin: false, plan: true },
  { email: 'listener3@peerbeats.test', name: 'Listener 3', contributor: false, admin: false, plan: true },
  { email: 'listener4@peerbeats.test', name: 'Listener 4', contributor: false, admin: false, plan: true },
  { email: 'listener5@peerbeats.test', name: 'Listener 5', contributor: false, admin: false, plan: true },
  { email: 'contributor.a@peerbeats.test', name: 'Contributor A', contributor: true, admin: false, plan: false },
  { email: 'contributor.b@peerbeats.test', name: 'Contributor B', contributor: true, admin: false, plan: false },
  { email: 'contributor.c@peerbeats.test', name: 'Contributor C', contributor: true, admin: false, plan: false },
  { email: 'contributor.d@peerbeats.test', name: 'Contributor D', contributor: true, admin: false, plan: false },
  { email: 'contributor.e@peerbeats.test', name: 'Contributor E', contributor: true, admin: false, plan: false },
  { email: 'admin@peerbeats.test', name: 'Admin', contributor: false, admin: true, plan: false },
  { email: 'new.listener@peerbeats.test', name: 'New Listener', contributor: false, admin: false, plan: false },
];

const db = await openDb();
try {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  // Their password is public, so these accounts must never exist outside a demo.
  for (const u of config.demoMode ? DEMO_USERS : []) {
    await db.query(
      `insert into users (email, password_hash, display_name, is_contributor, is_admin)
       values ($1, $2, $3, $4, $5) on conflict (email) do update set display_name = excluded.display_name`,
      [u.email, hash, u.name, u.contributor, u.admin],
    );
  }

  // Demo mode only: each of the five listeners buys a monthly plan on the test checkout, so every
  // plan has a payment behind it and revenue matches the number of subscribers. No real money.
  if (config.demoMode) {
    for (const u of DEMO_USERS.filter((user) => user.plan)) {
      const { rows } = await db.query<{ id: string }>('select id from users where email = $1', [u.email]);
      const { rows: paid } = await db.query(`select 1 from payments where user_id = $1 and status = 'captured' limit 1`, [rows[0].id]);
      if (!paid.length) await payWithTestPortal(db, rows[0].id, 'monthly');
    }
    // Earlier versions deducted a gateway fee from test payments, which no gateway charged.
    await db.query(`update payments set net_paise = amount_paise where source <> 'razorpay' and status = 'captured'`);
  }

  const tracks: SeedTrack[] = JSON.parse(fs.readFileSync(path.join(config.seedDir, 'metadata.json'), 'utf8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'peerbeats-seed-'));
  let created = 0;
  try {
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const { rows } = await db.query<{ id: string }>('select id from tracks where title = $1 and artist = $2', [t.title, t.artist]);
      if (rows[0]) {
        // A catalog row whose files were deleted can never play, so rebuild it.
        if (fs.existsSync(chunkPath('origin', rows[0].id, 0))) continue;
        await db.query('delete from tracks where id = $1', [rows[0].id]);
      }
      console.log(`  [${i + 1}/${tracks.length}] ${t.title} (${t.genre})`);
      const input = path.join(work, `${i}.wav`);
      fs.writeFileSync(input, renderTrack(t));
      await ingestTrack(db, { input, title: t.title, artist: t.artist, album: t.album, genre: t.genre, license: t.license });
      fs.rmSync(input, { force: true });
      created++;
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(created ? `  Seeded ${created} new track(s).` : `  ${tracks.length} tracks in the catalog`);
} finally {
  await db.close();
}
