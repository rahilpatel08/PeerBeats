/**
 * Stage 5 acceptance test. Runs a private copy of PeerBeats on temporary data, so it needs no
 * running server and can't touch real data: library, uploads, installing and offline behaviour.
 *   npm run test:stage5
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { io, type Socket } from 'socket.io-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'peerbeats-stage5-'));
const PORT = 4297;
const GATEWAY_PORT = 4296;
const PUBLIC_URL = 'https://peerbeats.example.test';
const BASE = `http://localhost:${PORT}`;

const env: Record<string, string> = {
  PEERBEATS_DATA_DIR: path.join(work, 'data'),
  PEERBEATS_STORAGE_DIR: path.join(work, 'storage'),
  PEERBEATS_ENV_FILE: path.join(work, '.env'),
  JWT_SECRET: 'test-only-secret',
  PORT: String(PORT),
  DEMO_MODE: 'true',
  // A stand-in for the phone link's address, so no real one is opened to the internet by a test.
  PUBLIC_URL,
  DATABASE_URL: '',
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  RAZORPAY_WEBHOOK_SECRET: '',
  RAZORPAY_API_BASE: `http://localhost:${GATEWAY_PORT}`,
  PAYOUT_CYCLE_SEC: '100000',
  REJECT_SHARED_IP: 'false',
};
Object.assign(process.env, env);
fs.writeFileSync(env.PEERBEATS_ENV_FILE, 'EXISTING=1\n', { mode: 0o644 });

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: unknown = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  [${detail}]` : ''}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const gateway = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end('{"items":[]}');
});
await new Promise<void>((resolve) => gateway.listen(GATEWAY_PORT, resolve));

const { openDb } = await import('../src/db.js');
const { ingestTrack } = await import('../scripts/ingest.js');
const { renderTrack } = await import('../scripts/synth.js');
const { grantMonthly } = await import('../src/payments/index.js');
const bcrypt = (await import('bcryptjs')).default;

const db = await openDb();
const hash = await bcrypt.hash('demo1234', 4);
const ACCOUNTS: [string, string, boolean, boolean][] = [
  ['admin', 'Lab Admin', false, true],
  ['listener', 'Demo Listener', false, false],
  ['other', 'Other Person', false, false],
  ['contributor.a', 'Contributor A', true, false],
  ['new.listener', 'New Listener', false, false],
];
for (const [name, display, contributor, admin] of ACCOUNTS) {
  await db.query('insert into users (email, password_hash, display_name, is_contributor, is_admin) values ($1, $2, $3, $4, $5)', [
    `${name}@peerbeats.test`, hash, display, contributor, admin,
  ]);
}
const { rows: listenerRow } = await db.query<{ id: string }>(`select id from users where email = 'listener@peerbeats.test'`);
await grantMonthly(db, listenerRow[0].id);
for (let i = 0; i < 3; i++) {
  const wav = path.join(work, `seed${i}.wav`);
  fs.writeFileSync(wav, renderTrack({ genre: 'House', bpm: 150, root: 45, scale: 'minor', progression: [0, 5, 3, 4], seed: 300 + i, targetSec: 20 }));
  await ingestTrack(db, { input: wav, title: `Track ${i}`, artist: 'Test', genre: 'House', license: 'CC0' });
}
await db.close();

let serverProcess: ChildProcess | null = null;
async function startServer() {
  serverProcess = spawn(path.join(SERVER_DIR, '..', 'node_modules', '.bin', 'tsx'), ['src/index.ts'], { cwd: SERVER_DIR, env: process.env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error('The test server did not start.');
}
async function stopServer() {
  const proc = serverProcess;
  if (!proc) return;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
  });
  serverProcess = null;
}
function finish(code: number) {
  stopServer().finally(() => {
    gateway.close();
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(code);
  });
}
process.on('uncaughtException', (err) => {
  console.error('The test crashed:', err);
  finish(2);
});
setTimeout(() => {
  console.error('TIMED OUT');
  finish(3);
}, 240000).unref();

const call = async (method: string, url: string, token?: string, body?: unknown) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const login = async (name: string): Promise<string> => (await call('POST', '/api/auth/login', undefined, { email: `${name}@peerbeats.test`, password: 'demo1234' })).data.token;

function makeAudio(ext: string, args: string[]) {
  const out = path.join(work, `tone.${ext}`);
  const result = spawnSync(ffmpegPath as unknown as string, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', ...args, out]);
  if (result.status !== 0) throw new Error(`Could not make ${ext}: ${result.stderr}`);
  return fs.readFileSync(out);
}

try {
  await startServer();
  const [listener, other, admin] = [await login('listener'), await login('other'), await login('admin')];
  const contributorToken = await login('contributor.a');
  const tracks = (await call('GET', '/api/tracks', listener)).data.tracks;
  const [t0, t1, t2] = tracks;

  console.log('\nLiked songs');
  check('Likes need a login', (await call('GET', '/api/likes')).status === 401);
  check('Liking works', (await call('PUT', `/api/likes/${t0.id}`, listener)).data.liked === true);
  await call('PUT', `/api/likes/${t0.id}`, listener);
  check('Liking twice keeps one entry', (await call('GET', '/api/likes', listener)).data.tracks.length === 1);
  check('A malformed id is refused', (await call('PUT', '/api/likes/not-an-id', listener)).status === 400);
  check('An unknown song is refused', (await call('PUT', '/api/likes/00000000-0000-4000-8000-000000000000', listener)).status === 404);
  check('Likes are private to each person', (await call('GET', '/api/likes', other)).data.tracks.length === 0);
  await call('DELETE', `/api/likes/${t0.id}`, listener);
  check('Unliking works', (await call('GET', '/api/likes', listener)).data.tracks.length === 0);

  console.log('\nPlaylists');
  check('Playlists need a login', (await call('GET', '/api/playlists')).status === 401);
  check('An empty name is refused', (await call('POST', '/api/playlists', listener, { name: '   ' })).status === 400);
  check('An overlong name is refused', (await call('POST', '/api/playlists', listener, { name: 'x'.repeat(81) })).status === 400);
  const created = await call('POST', '/api/playlists', listener, { name: 'Road Trip' });
  const pid = created.data.playlist.id;
  check('Creating works', created.status === 201);
  await call('POST', `/api/playlists/${pid}/tracks`, listener, { trackId: t2.id });
  await call('POST', `/api/playlists/${pid}/tracks`, listener, { trackId: t0.id });
  await call('POST', `/api/playlists/${pid}/tracks`, listener, { trackId: t1.id });
  await call('POST', `/api/playlists/${pid}/tracks`, listener, { trackId: t0.id });
  const list = (await call('GET', `/api/playlists/${pid}`, listener)).data.playlist.tracks.map((t: any) => t.id);
  check('Songs stay in the order added', list.join() === [t2.id, t0.id, t1.id].join());
  check('Adding a song twice keeps one copy', list.length === 3);
  check('An unknown song is refused', (await call('POST', `/api/playlists/${pid}/tracks`, listener, { trackId: '00000000-0000-4000-8000-000000000000' })).status === 404);

  console.log("\nSomeone else's playlist");
  check("It can't be read", (await call('GET', `/api/playlists/${pid}`, other)).status === 404);
  check("It can't be added to", (await call('POST', `/api/playlists/${pid}/tracks`, other, { trackId: t0.id })).status === 404);
  check("Songs can't be removed from it", (await call('DELETE', `/api/playlists/${pid}/tracks/${t0.id}`, other)).status === 404);
  check("It can't be deleted", (await call('DELETE', `/api/playlists/${pid}`, other)).status === 404);
  check("It isn't listed", (await call('GET', '/api/playlists', other)).data.playlists.length === 0);
  check('It is untouched by all that', (await call('GET', `/api/playlists/${pid}`, listener)).data.playlist.tracks.length === 3);

  await call('DELETE', `/api/playlists/${pid}/tracks/${t0.id}`, listener);
  const summary = (await call('GET', '/api/playlists', listener)).data.playlists[0];
  check('Removing a song works', summary.trackCount === 2 && !summary.trackIds.includes(t0.id));
  await call('DELETE', `/api/playlists/${pid}`, listener);
  check('Deleting works', (await call('GET', '/api/playlists', listener)).data.playlists.length === 0);

  console.log('\nWho can upload');
  const mp3 = makeAudio('mp3', ['-c:a', 'libmp3lame', '-b:a', '96k']);
  const upload = async (bytes: Buffer, meta: Record<string, string>, token: string | undefined = admin) => {
    const res = await fetch(`${BASE}/api/admin/tracks?${new URLSearchParams(meta)}`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const meta = (title: string) => ({ title, artist: 'Uploader', license: 'CC0', genre: 'Test' });
  check('Without a login, refused', (await upload(mp3, meta('A'), '')).status === 401);
  check('A non-admin is refused', (await upload(mp3, meta('A'), listener)).status === 403);

  console.log('\nBad uploads');
  check('No license is refused', (await upload(mp3, { title: 'A', artist: 'B' })).status === 400);
  check('A commercial or unknown license is refused', (await upload(mp3, { title: 'A', artist: 'B', license: 'All rights reserved' })).status === 400);
  check('No title is refused', (await upload(mp3, { artist: 'B', license: 'CC0' })).status === 400);
  check('An empty file is refused', (await upload(Buffer.alloc(0), meta('A'))).status === 400);
  check('A text file is refused', (await upload(Buffer.from('hello, this is not audio at all'), meta('A'))).status === 415);
  const secretFile = path.join(work, 'private-file.txt');
  fs.writeFileSync(secretFile, 'PRIVATE');
  const attack = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile://${secretFile}\n#EXT-X-ENDLIST\n`;
  check('A disguised playlist is refused unopened', (await upload(Buffer.from(attack), meta('A'))).status === 415);
  const tooBig = Buffer.alloc(51 * 1024 * 1024);
  const big = await upload(tooBig, meta('A'));
  check('A file over 50 MB is refused with a clear message', big.status === 413 && big.data?.error?.includes('50 MB'), big.status);

  const jobs = async () => (await call('GET', '/api/admin/ingest', admin)).data.jobs;
  const waitForJob = async (title: string) => {
    for (let i = 0; i < 150; i++) {
      const job = (await jobs()).find((j: any) => j.title === title);
      if (job && (job.status === 'done' || job.status === 'failed')) return job;
      await sleep(100);
    }
    return null;
  };
  const tracksCount = async () => (await call('GET', '/api/tracks', listener)).data.tracks.length;
  const beforeBad = await tracksCount();
  // Passes the first-bytes check, so this one proves ffmpeg itself can't be tricked.
  const accepted = await upload(Buffer.concat([Buffer.from('ID3'), Buffer.from(attack)]), meta('Sneaky'));
  const sneaky = await waitForJob('Sneaky');
  check('A playlist behind a fake header fails safely', accepted.status === 202 && sneaky?.status === 'failed', sneaky?.status);
  check('...with a plain message, not internal details', sneaky?.error === 'This file couldn’t be read as audio.', sneaky?.error);
  const junk = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4000, 7)]);
  await upload(junk, meta('Junk'));
  check('A corrupt WAV fails safely', (await waitForJob('Junk'))?.status === 'failed');
  check('Failed uploads add nothing to the catalog', (await tracksCount()) === beforeBad);

  console.log('\nGood uploads, and contributors receiving them');
  const peer: Socket = io(BASE, { auth: { token: contributorToken }, transports: ['websocket'], reconnection: false });
  await new Promise<void>((resolve, reject) => {
    peer.once('connect', () => resolve());
    peer.once('connect_error', reject);
  });
  const assigned: string[] = [];
  peer.on('peer:assign', ({ chunks }) => {
    if (!chunks.length) return;
    assigned.push(...chunks.map((c: any) => c.id));
    peer.emit('peer:have', { chunkIds: chunks.map((c: any) => c.id) });
  });
  await new Promise((resolve) => peer.emit('peer:hello', { quotaMb: 200 }, resolve));
  peer.emit('peer:have', { chunkIds: [] });
  await sleep(400);
  const startedAt = Date.now();
  check('A real MP3 is accepted', (await upload(mp3, meta('Good MP3'))).status === 202);
  const goodJob = await waitForJob('Good MP3');
  check('It is processed', goodJob?.status === 'done', goodJob?.error ?? `${goodJob?.segments} segments`);
  const added = (await call('GET', '/api/tracks?query=Good%20MP3', listener)).data.tracks[0];
  check('It is in the catalog with its license', added?.license === 'CC0' && added?.artist === 'Uploader');
  const manifest = await call('GET', `/api/tracks/${added.id}/manifest`, listener);
  check('A listener with a plan can get it', manifest.status === 200 && manifest.data.chunks.length === goodJob.segments + 1);
  let sent = false;
  while (!sent && Date.now() - startedAt < 4000) {
    sent = manifest.data.chunks.every((c: any) => assigned.includes(c.id));
    await sleep(50);
  }
  check('Contributors are sent it straight away', sent, `${Date.now() - startedAt} ms`);
  const coverRes = await fetch(BASE + added.coverUrl);
  check('It gets a cover', coverRes.ok && (coverRes.headers.get('content-type') ?? '').includes('svg'));
  check('The same title and artist twice is refused', (await upload(mp3, meta('Good MP3'))).status === 409);
  peer.disconnect();

  for (const [ext, args] of [
    ['wav', []],
    ['flac', ['-c:a', 'flac']],
    ['ogg', ['-c:a', 'libvorbis']],
    ['m4a', ['-c:a', 'aac']],
  ] as [string, string[]][]) {
    let bytes: Buffer;
    try {
      bytes = makeAudio(ext, args);
    } catch {
      console.log(`  SKIP  ${ext}: this copy of ffmpeg can't make one`);
      continue;
    }
    await upload(bytes, meta(`Format ${ext}`));
    const job = await waitForJob(`Format ${ext}`);
    check(`${ext.toUpperCase()} works`, job?.status === 'done', job?.error ?? '');
  }
  const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('peerbeats-upload-'));
  check('Uploads leave no temporary files behind', leftovers.length === 0, leftovers.length);

  console.log('\nPayment portal');
  const buyer = await login('new.listener');
  const sub = async (token: string) => (await call('GET', '/api/subscription', token)).data;
  check('It starts off', (await sub(buyer)).portalActive === false);
  check('Paying is refused while it is off', (await call('POST', '/api/payments/portal/pay', buyer, { plan: 'monthly' })).status === 403);
  check('Activating needs a login', (await call('POST', '/api/payments/portal', undefined, { code: 'admin' })).status === 401);
  check('A wrong code is refused', (await call('POST', '/api/payments/portal', buyer, { code: 'wrong' })).status === 403);
  check('A nearly right code is refused', (await call('POST', '/api/payments/portal', buyer, { code: 'Admin' })).status === 403);
  check('...and it stays off', (await sub(buyer)).portalActive === false);
  check('The code admin turns it on', (await call('POST', '/api/payments/portal', buyer, { code: 'admin' })).data.portalActive === true);
  check('It shows as on for everyone', (await sub(other)).portalActive === true);
  const grossBefore = (await call('GET', '/api/admin/revenue', admin)).data.grossPaise;
  const bought = await call('POST', '/api/payments/portal/pay', other, { plan: 'monthly', amount: 1 });
  check('A test payment activates the plan', bought.status === 200 && bought.data.access.plan === 'monthly');
  const revenueNow = (await call('GET', '/api/admin/revenue', admin)).data;
  check('It counts at the real price, whatever is sent', revenueNow.grossPaise === grossBefore + 9900, revenueNow.grossPaise - grossBefore);
  check('The Monitor shows it is not a Razorpay payment', revenueNow.payments === revenueNow.razorpayPayments + 1);
  check('An unknown plan is refused', (await call('POST', '/api/payments/portal/pay', other, { plan: 'free' })).status === 400);
  check('No gateway fee is taken from a test payment', revenueNow.feePaise === 0, revenueNow.feePaise);
  await call('DELETE', '/api/payments/portal', buyer);
  check('It can be turned off', (await sub(buyer)).portalActive === false);
  check('Paying is refused again', (await call('POST', '/api/payments/portal/pay', buyer, { plan: 'monthly' })).status === 403);
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) limited = (await call('POST', '/api/payments/portal', buyer, { code: `guess${i}` })).status === 429;
  check('Guessing the code is limited', limited);

  console.log('\nPhone accounts and the free-plan code');
  // Guessing above used up the code limit, and restarting the server resets it.
  await stopServer();
  await startServer();
  const phoneSignup = await call('POST', '/api/auth/phone', undefined, { displayName: 'Phone Listener', role: 'listener' });
  check('A phone account needs only a name and a role', phoneSignup.status === 201 && phoneSignup.data.user.isContributor === false && phoneSignup.data.user.email.endsWith('@peerbeats.invalid'));
  const phoneContributor = await call('POST', '/api/auth/phone', undefined, { displayName: 'Phone Contributor', role: 'contributor' });
  check('Choosing contributor makes a contributor', phoneContributor.status === 201 && phoneContributor.data.user.isContributor === true);
  check('A role must be one of the two', (await call('POST', '/api/auth/phone', undefined, { displayName: 'X', role: 'admin' })).status === 400);
  check('A name is needed', (await call('POST', '/api/auth/phone', undefined, { displayName: ' ', role: 'listener' })).status === 400);
  const phoneToken = phoneSignup.data.token;
  check('Its sign-in lasts much longer than an email login', JSON.parse(Buffer.from(phoneToken.split('.')[1], 'base64url').toString()).exp - Date.now() / 1000 > 300 * 86400);
  check('It starts with no plan', (await sub(phoneToken)).access.active === false);
  check('A wrong code is refused', (await call('POST', '/api/payments/code', phoneToken, { code: 'nope' })).status === 403);
  const freeBefore = (await call('GET', '/api/admin/revenue', admin)).data.grossPaise;
  const redeemed = await call('POST', '/api/payments/code', phoneToken, { code: ' ADMIN ' });
  check('The code admin gives a monthly plan', redeemed.status === 200 && redeemed.data.access.plan === 'monthly', JSON.stringify(redeemed.data));
  const again = await call('POST', '/api/payments/code', phoneToken, { code: 'admin' });
  check('Using it again adds no second free month', again.data.access.endsAt === redeemed.data.access.endsAt);
  check('It is booked once, as a test payment, so contributors still earn', (await call('GET', '/api/admin/revenue', admin)).data.grossPaise === freeBefore + 9900);
  const switched = await call('POST', '/api/me/contributor', phoneToken, { enabled: true });
  check('A listener can switch to contributor', switched.data.user.isContributor === true);
  await call('POST', '/api/me/contributor', phoneToken, { enabled: false });

  console.log('\nClearing delivery and payout records');
  check('Only this laptop can clear them', (await fetch(`${BASE}/api/lab/reset-activity`, { method: 'POST' })).status === 403);
  const cleared = await fetch(`${BASE}/api/lab/reset-activity`, { method: 'POST', headers: { 'X-PeerBeats-Lab': '1' } });
  const afterClear = (await call('GET', '/api/admin/revenue', admin)).data;
  check('Clearing works and leaves no payouts', cleared.status === 200 && afterClear.paidPaise === 0 && afterClear.cycles.length === 0 && afterClear.recognizedPaise === 0);
  check('Payments and plans stay', afterClear.payments > 0 && (await sub(other)).access.plan === 'monthly');

  console.log('\nInstalling');
  const manifestRes = await fetch(`${BASE}/manifest.webmanifest`);
  const webManifest = await manifestRes.json();
  check('The app manifest is served', manifestRes.ok && webManifest.name === 'PeerBeats' && webManifest.display === 'standalone');
  const sizes = new Set<string>();
  for (const icon of webManifest.icons) {
    const res = await fetch(BASE + icon.src);
    const png = Buffer.from(await res.arrayBuffer());
    const size = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
    if (res.ok && size === icon.sizes) sizes.add(size + (icon.purpose === 'maskable' ? ' maskable' : ''));
  }
  check('Every icon exists at its stated size', sizes.has('192x192') && sizes.has('512x512') && sizes.has('512x512 maskable'), [...sizes].join(', '));
  const sw = await fetch(`${BASE}/sw.js`);
  check('Browsers always check for a new version', sw.ok && sw.headers.get('cache-control') === 'no-cache', sw.headers.get('cache-control'));
  const swText = await sw.text();
  check('The offline cache holds no music, keys or account data', !/"url":"\/?(api|seeder|socket\.io)/.test(swText));

  console.log('\nThe phone link, for phones anywhere');
  const labStatus = (await call('GET', '/api/lab/status')).data;
  check('The Lab shows the one address phones use', labStatus.link?.state === 'on' && labStatus.link.url === PUBLIC_URL, JSON.stringify(labStatus.link));
  check('The Wi-Fi address and its certificate are gone', labStatus.wifi === undefined && labStatus.tunnel === undefined && (await fetch(`${BASE}/api/join/certificate`)).status === 404);
  // Requests from a phone arrive through the link, which marks them with these headers.
  const PHONE = { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '203.0.113.7' };
  const asPhone = async (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(BASE + pathname, {
      method,
      headers: { ...PHONE, ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON: a page.
    }
    return { status: res.status, text, data };
  };
  const phoneHealth = await asPhone('GET', '/api/health');
  check('The app answers a phone', phoneHealth.status === 200 && phoneHealth.data.app === 'peerbeats', phoneHealth.status);
  check('A phone is not treated as the laptop, so it gets no Lab', phoneHealth.data.local === false);
  check('The laptop itself is', (await call('GET', '/api/health')).data.local === true);
  check('The app page loads for a phone', (await asPhone('GET', '/lab')).text.includes('<div id="root">'));
  check('A phone is refused the Lab entirely', (await asPhone('GET', '/api/lab/status')).status === 403);
  const joinInfo = (await asPhone('GET', '/api/join')).data;
  check('Anyone can learn the address, and nothing about anyone', joinInfo.link.url === PUBLIC_URL && Object.keys(joinInfo).join() === 'link' && Object.keys(joinInfo.link).sort().join() === 'state,url', JSON.stringify(joinInfo));
  const LAB = { 'X-PeerBeats-Lab': '1' };
  check('Laptop-only controls stay refused from a phone', (await asPhone('POST', '/api/lab/reset-activity', undefined, LAB)).status === 403);
  check('A phone can’t turn the link off or change it', (await asPhone('DELETE', '/api/lab/link', undefined, LAB)).status === 403 && (await asPhone('POST', '/api/lab/link/new', undefined, LAB)).status === 403);
  const demoLogin = { email: 'admin@peerbeats.test', password: 'demo1234' };
  const refused = await asPhone('POST', '/api/auth/login', demoLogin);
  check('Demo accounts can’t be used from a phone, so nobody outside gets the admin', refused.status === 403 && !refused.data.token, refused.status);
  check('They still work on the laptop', (await call('POST', '/api/auth/login', undefined, demoLogin)).status === 200);
  const viaLink = await asPhone('POST', '/api/auth/phone', { displayName: 'Faraway Friend', role: 'listener' });
  check('A phone starts its own account through the link', viaLink.status === 201 && Boolean(viaLink.data.token), viaLink.status);
  const farSocket: Socket = io(BASE, { auth: { token: viaLink.data.token }, transports: ['websocket'], reconnection: false, extraHeaders: PHONE });
  const farResult = await new Promise<string>((resolve) => {
    farSocket.once('connect', () => resolve('connected'));
    farSocket.once('connect_error', (err) => resolve(err.message));
    setTimeout(() => resolve('timed out'), 8000);
  });
  farSocket.close();
  check('Phones reach the tracker through it', farResult === 'connected', farResult);
  const lanAddress = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!lanAddress) {
    console.log('  SKIP  This computer has no local network address to try');
  } else {
    const reached = await new Promise<string>((resolve) => {
      const probe = net.connect({ host: lanAddress, port: PORT });
      probe.once('connect', () => {
        probe.destroy();
        resolve('connected');
      });
      probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      setTimeout(() => resolve('no answer'), 3000);
    });
    check('Nothing on the local network can connect: only this computer and the link', reached !== 'connected', reached);
  }
  const lab = (method: string, pathname: string) => fetch(BASE + pathname, { method, headers: LAB }).then((r) => r.json());
  check('The laptop can turn the link off', (await lab('DELETE', '/api/lab/link')).state === 'off' && (await call('GET', '/api/join')).data.link.url === null);
  check('And on again', (await lab('POST', '/api/lab/link')).state === 'on' && (await call('GET', '/api/join')).data.link.url === PUBLIC_URL);

  console.log('\nThe relay, for phones that can’t connect directly');
  {
    const connect = async (token: string) => {
      const socket: Socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      return socket;
    };
    const next = <T>(socket: Socket, event: string, ms = 3000) =>
      new Promise<T | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        socket.once(event, (data: T) => {
          clearTimeout(timer);
          resolve(data);
        });
      });
    const sendData = (socket: Socket, message: unknown) => new Promise<boolean>((resolve) => socket.timeout(3000).emit('relay:data', message, (err: Error | null, ok?: boolean) => resolve(!err && ok === true)));

    const giver = await connect(await login('contributor.a'));
    const { peerSessionId } = await new Promise<{ peerSessionId: string }>((resolve) => giver.emit('peer:hello', { quotaMb: 64 }, resolve));
    const hearer = await connect(await login('listener'));
    const stranger = await connect(await login('other'));

    const asked = next<{ from: string }>(giver, 'relay:open');
    hearer.emit('relay:open', { to: peerSessionId });
    check('A listener asks, and the contributor is told who is asking', (await asked)?.from === hearer.id);
    const agreed = next<{ from: string }>(hearer, 'relay:accept');
    giver.emit('relay:accept', { to: hearer.id });
    check('The contributor agrees, and the listener is told', (await agreed)?.from === peerSessionId);

    const request = next<{ from: string; data: string }>(giver, 'relay:data');
    const requestSent = await sendData(hearer, { to: peerSessionId, kind: 'listener', data: '{"type":"get","chunkId":"x"}' });
    const got = await request;
    check('A request reaches the contributor', requestSent && got?.from === hearer.id && got?.data === '{"type":"get","chunkId":"x"}');

    const pieces = [1, 2, 3].map((n) => Buffer.alloc(16 * 1024, n));
    const arrived: Buffer[] = [];
    hearer.on('relay:data', ({ from, data }: { from: string; data: Buffer }) => {
      if (from === peerSessionId && Buffer.isBuffer(data)) arrived.push(data);
    });
    const confirmed = await Promise.all(pieces.map((data) => sendData(giver, { to: hearer.id, kind: 'contributor', data })));
    for (let i = 0; i < 30 && arrived.length < 3; i++) await sleep(100);
    check('Pieces come back whole, unchanged and in order', confirmed.every(Boolean) && arrived.length === 3 && arrived.every((piece, i) => piece.equals(pieces[i])), `${arrived.length} arrived`);

    const leak = next(giver, 'relay:data', 800);
    const strangerSent = await sendData(stranger, { to: peerSessionId, kind: 'listener', data: '{"type":"get","chunkId":"x"}' });
    check('Someone who never asked can’t send through it', strangerSent === false && (await leak) === null);
    check('A contributor can’t push data at someone who never asked', (await sendData(giver, { to: stranger.id, kind: 'contributor', data: pieces[0] })) === false);
    check('Anything much bigger than a piece is refused', (await sendData(giver, { to: hearer.id, kind: 'contributor', data: Buffer.alloc(100 * 1024, 9) })) === false);

    const watcher = await connect(admin);
    const seen = next<{ totals: { relayedBytes: number } }>(watcher, 'admin:network');
    watcher.emit('admin:watch');
    const relayed = (await seen)?.totals.relayedBytes;
    check('The Monitor counts exactly what was relayed', relayed === 3 * 16 * 1024, relayed);
    watcher.close();

    const unknown = next<{ from: string }>(stranger, 'relay:close');
    stranger.emit('relay:open', { to: '00000000-0000-4000-8000-000000000000' });
    check('Asking for a contributor who isn’t there is refused at once', (await unknown)?.from === '00000000-0000-4000-8000-000000000000');

    const strangerAsked = next<{ from: string }>(giver, 'relay:open');
    stranger.emit('relay:open', { to: peerSessionId });
    await strangerAsked;
    const strangerId = stranger.id;
    const told = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      giver.on('relay:close', ({ from }: { from: string }) => {
        if (from !== strangerId) return;
        clearTimeout(timer);
        resolve(from);
      });
    });
    stranger.close();
    check('When a listener disappears, the contributor is told', (await told) === strangerId);

    const ended = next<{ from: string }>(hearer, 'relay:close');
    giver.emit('peer:bye');
    check('When a contributor stops sharing, the listener is told', (await ended)?.from === peerSessionId);
    await sleep(200);
    check('After that, nothing more can be sent to it', (await sendData(hearer, { to: peerSessionId, kind: 'listener', data: '{"type":"ping"}' })) === false);
    giver.close();
    hearer.close();
  }

  console.log('\nIn real Chrome');
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(CHROME)) {
    console.log('  SKIP  Chrome is not installed');
  } else {
    const puppeteer = (await import('puppeteer-core')).default;
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: fs.mkdtempSync(path.join(work, 'chrome-')), args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-audio-output'], defaultViewport: { width: 1280, height: 850 } });
    const errors: string[] = [];
    const watch = (p: any) => p.on('pageerror', (e: Error) => errors.push(e.message));
    const clickText = (p: any, selector: string, text: string) =>
      p.evaluate((selector: string, text: string) => {
        const el = [...document.querySelectorAll(selector)].find((e) => (e.textContent ?? '').includes(text)) as HTMLElement | undefined;
        if (!el) throw new Error(`missing: ${text}`);
        el.click();
      }, selector, text);

    console.log('\n  Library');
    const page = await browser.newPage();
    watch(page);
    await page.goto(`${BASE}/?as=listener&go=%2F`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('main li button');
    await page.evaluate(() => (document.querySelector('main li button[aria-label^="Like"]') as HTMLElement).click());
    await page.evaluate(() => {
      const open = [...document.querySelectorAll('main li button')].find((b) => b.getAttribute('aria-label')?.startsWith('Add ')) as HTMLElement;
      open.click();
    });
    await page.waitForSelector('main li form input');
    await page.type('main li form input', 'Morning Mix');
    await page.keyboard.press('Enter');
    await sleep(400);
    await page.evaluate(() => (document.querySelector('a[href="/library"]') as HTMLElement).click());
    await page.waitForSelector('[data-testid="playlist-list"] a');
    await sleep(300);
    const library = await page.evaluate(() => ({
      playlists: [...document.querySelectorAll('[data-testid="playlist-list"] a')].map((a) => a.textContent),
      liked: document.querySelectorAll('[data-testid="liked-list"] li').length,
    }));
    check('A liked song appears in the Library', library.liked === 1, library.liked);
    check('A playlist made from a song appears, holding it', (library.playlists[0] ?? '').includes('Morning Mix') && (library.playlists[0] ?? '').includes('1 song'), library.playlists[0]);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="playlist-list"] a');
    check('They survive a reload', (await page.$$eval('[data-testid="liked-list"] li', (e) => e.length)) === 1);
    await page.evaluate(() => (document.querySelector('[data-testid="playlist-list"] a') as HTMLElement).click());
    await page.waitForSelector('button[aria-label^="Remove"][aria-label$="playlist"]');
    await page.evaluate(() => (document.querySelector('button[aria-label^="Remove"][aria-label$="playlist"]') as HTMLElement).click());
    await sleep(400);
    check('Removing leaves an empty playlist with guidance', (await page.evaluate(() => document.body.innerText)).includes('Empty so far'));
    await clickText(page, 'button', 'Delete playlist');
    await sleep(400);
    check('Deleting returns to the Library', page.url().endsWith('/library') && (await page.$$eval('[data-testid="playlist-list"] a', (e) => e.length)) === 0);
    await page.close();

    console.log('\n  Upload screen');
    const cat = await browser.newPage();
    watch(cat);
    await cat.goto(`${BASE}/?as=admin&go=%2Fcatalog`, { waitUntil: 'networkidle2' });
    await cat.waitForSelector('[data-testid="upload-file"]');
    const labels = await cat.$$('form input:not([type=file]):not([type=checkbox])');
    await labels[0].type('Screen Upload');
    await labels[1].type('Via Browser');
    await cat.select('form select', 'CC0');
    await cat.click('form input[type=checkbox]');
    const input = (await cat.$('[data-testid="upload-file"]'))!;
    const toneFile = path.join(work, 'tone.mp3');
    fs.writeFileSync(toneFile, mp3);
    await (input as any).uploadFile(toneFile);
    await clickText(cat, 'form button', 'Upload');
    await cat.waitForFunction(() => (document.querySelector('[data-testid="ingest-jobs"]')?.textContent ?? '').includes('Screen Upload'), { timeout: 8000, polling: 200 });
    await cat.waitForFunction(() => [...document.querySelectorAll('[data-testid="ingest-jobs"] li')].some((l) => l.textContent?.includes('Screen Upload') && l.textContent?.includes('Added')), { timeout: 15000, polling: 200 });
    check('A track uploaded on the page finishes and shows its status', true);
    check('It joins the catalog table', (await cat.evaluate(() => document.body.innerText)).includes('Via Browser'));
    const fakeFile = path.join(work, 'fake.mp3');
    fs.writeFileSync(fakeFile, 'not really audio, whatever the name says');
    const labels2 = await cat.$$('form input:not([type=file]):not([type=checkbox])');
    await labels2[0].type('Fake');
    await labels2[1].type('Nobody');
    await cat.select('form select', 'CC0');
    await cat.click('form input[type=checkbox]');
    await ((await cat.$('[data-testid="upload-file"]'))! as any).uploadFile(fakeFile);
    await clickText(cat, 'form button', 'Upload');
    await cat.waitForSelector('[data-testid="upload-error"]', { timeout: 5000 });
    check('A file with a fake name shows a clear error', (await cat.$eval('[data-testid="upload-error"]', (e) => e.textContent ?? '')).includes('supported audio'));
    await cat.close();

    console.log('\n  Sharing limits');
    const stub = () => {
      const connection = new EventTarget() as any;
      connection.type = 'cellular';
      const battery = new EventTarget() as any;
      battery.level = 1;
      battery.charging = true;
      Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
      (navigator as any).getBattery = () => Promise.resolve(battery);
      (window as any).__fake = { connection, battery };
    };
    const share = await browser.newPage();
    watch(share);
    await share.evaluateOnNewDocument(stub);
    await share.goto(`${BASE}/?as=contributor.a&go=%2Fshare`, { waitUntil: 'networkidle2' });
    await share.waitForSelector('[data-testid="option-wifiOnly"]');
    await sleep(300);
    const status = () => share.$eval('[data-testid="share-status"]', (e) => e.textContent ?? '');
    const waitStatus = async (text: string) => {
      for (let i = 0; i < 60; i++) {
        if ((await status()).includes(text)) return true;
        await sleep(100);
      }
      return false;
    };
    await share.click('[data-testid="option-wifiOnly"]');
    await share.click('button[role=switch]');
    check('Wi-Fi only blocks sharing on mobile data', await waitStatus('on mobile data'), await status());
    const noSession = async () => (await call('GET', '/api/admin/network', admin)).data.peers.length === 0;
    check('The tracker sees no contributor', await noSession());
    await share.evaluate(() => {
      const { connection } = (window as any).__fake;
      connection.type = 'wifi';
      connection.dispatchEvent(new Event('change'));
    });
    check('It starts by itself on Wi-Fi', await waitStatus('Sharing active'), await status());
    await share.evaluate(() => {
      const { connection } = (window as any).__fake;
      connection.type = 'cellular';
      connection.dispatchEvent(new Event('change'));
    });
    check('It pauses by itself back on mobile data', await waitStatus('on mobile data'), await status());
    await sleep(300);
    check('...and the tracker drops it', await noSession());
    await share.click('button[role=switch]');
    await sleep(200);
    await share.evaluate(() => {
      const { connection } = (window as any).__fake;
      connection.type = 'wifi';
      connection.dispatchEvent(new Event('change'));
    });
    await sleep(800);
    check('Turned off by hand, it stays off even on Wi-Fi', (await status()) === 'Sharing is off', await status());

    await share.click('[data-testid="option-stopOnLowBattery"]');
    await share.click('button[role=switch]');
    await waitStatus('Sharing active');
    await share.evaluate(() => {
      const { battery } = (window as any).__fake;
      battery.level = 0.1;
      battery.charging = false;
      battery.dispatchEvent(new Event('levelchange'));
    });
    check('Low battery pauses it', await waitStatus('low battery'), await status());
    await share.evaluate(() => {
      const { battery } = (window as any).__fake;
      battery.charging = true;
      battery.dispatchEvent(new Event('chargingchange'));
    });
    check('Charging resumes it', await waitStatus('Sharing active'), await status());
    await share.click('button[role=switch]');
    await share.close();

    const unsupported = await browser.newPage();
    await unsupported.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
      (navigator as any).getBattery = undefined;
    });
    await unsupported.goto(`${BASE}/?as=contributor.a&go=%2Fshare`, { waitUntil: 'networkidle2' });
    await unsupported.waitForSelector('[data-testid="option-wifiOnly"]');
    await sleep(200);
    const disabled = await unsupported.evaluate(() => ({
      wifi: (document.querySelector('[data-testid="option-wifiOnly"]') as HTMLInputElement).disabled,
      battery: (document.querySelector('[data-testid="option-stopOnLowBattery"]') as HTMLInputElement).disabled,
      text: document.body.innerText,
    }));
    check('On phones without these features, the options say so', disabled.wifi && disabled.battery && disabled.text.includes("can’t tell Wi-Fi"));
    await unsupported.close();

    console.log('\n  Phone-sized screens');
    const phone = await browser.newPage();
    watch(phone);
    await phone.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await phone.goto(`${BASE}/?as=admin&go=%2F`, { waitUntil: 'networkidle2' });
    for (const route of ['/', '/search', '/library', '/share', '/subscribe', '/monitor', '/catalog', '/lab']) {
      await phone.goto(BASE + route, { waitUntil: 'networkidle2' });
      await sleep(300);
      const fits = await phone.evaluate(() => {
        const doc = document.documentElement;
        const main = document.querySelector('main');
        return doc.scrollWidth <= doc.clientWidth && (!main || main.scrollWidth <= main.clientWidth);
      });
      check(`${route} fits with no sideways scrolling`, fits);
    }
    await phone.close();

    console.log('\n  A new phone: choosing listener or contributor');
    // Earlier code checks count against the limit too, so start from a fresh server.
    await stopServer();
    await startServer();
    // A fresh browser profile, like a phone that has never opened PeerBeats.
    const fresh = await browser.createBrowserContext();
    const newcomer = await fresh.newPage();
    watch(newcomer);
    await newcomer.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await newcomer.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
    check('It opens on the choice of listener or contributor', (await newcomer.$('[data-testid="role-listener"]')) !== null && (await newcomer.$('[data-testid="role-contributor"]')) !== null);
    await newcomer.click('[data-testid="role-contributor"]');
    await newcomer.type('[data-testid="your-name"]', 'Tester Contributor');
    await clickText(newcomer, 'button[type=submit]', 'Continue as contributor');
    await newcomer.waitForFunction(() => location.pathname === '/share', { timeout: 8000 });
    let shareText = '';
    for (let i = 0; i < 60 && !shareText.startsWith('Sharing active'); i++) {
      await sleep(500);
      shareText = await newcomer.evaluate(() => `${document.querySelector('[data-testid="share-status"]')?.textContent ?? ''} ${document.querySelector('[role="alert"]')?.textContent ?? ''}`.trim());
    }
    check('A contributor lands on Contribute, and sharing starts by itself', shareText.startsWith('Sharing active'), shareText);
    check('Contribute shows the money received', (await newcomer.$('[data-testid="earn-Earned"]')) !== null);
    const contributorMenu = await newcomer.$$eval('nav[aria-label="Main"] a', (links) => [...new Set(links.map((l) => l.textContent?.trim()))]);
    check('The contributor menu is Contribute plus the listening pages', contributorMenu.join(',') === 'Contribute,Home,Search,Library,Plan,Account', contributorMenu.join(','));
    // Moving within the app, not reloading, the way a person would.
    await clickText(newcomer, 'nav[aria-label="Main"] a', 'Home');
    await newcomer.waitForSelector('main li button', { timeout: 8000 });
    check('A contributor can browse the songs', newcomer.url().endsWith('/'), newcomer.url());
    await newcomer.evaluate(() => (document.querySelector('main li button') as HTMLElement).click());
    await newcomer.waitForSelector('[data-testid="player-error"]', { timeout: 8000 });
    check('Playing still needs a plan', ((await newcomer.$eval('[data-testid="player-error"]', (e) => e.textContent ?? '')).includes('need a plan')));
    await clickText(newcomer, 'nav[aria-label="Main"] a', 'Contribute');
    await newcomer.waitForSelector('[data-testid="share-status"]');
    check('Sharing kept running while they browsed', (await newcomer.$eval('[data-testid="share-status"]', (e) => e.textContent ?? '')).startsWith('Sharing active'));
    await newcomer.goto(`${BASE}/monitor`, { waitUntil: 'networkidle2' });
    check('Admin pages send a contributor back to Contribute', newcomer.url().endsWith('/share'), newcomer.url());
    await newcomer.goto(`${BASE}/lab`, { waitUntil: 'networkidle2' });
    check('This is the laptop, so the Lab opens here', newcomer.url().endsWith('/lab'), newcomer.url());
    await newcomer.close();
    await fresh.close();

    const fresh2 = await browser.createBrowserContext();
    const plan = await fresh2.newPage();
    watch(plan);
    await plan.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await plan.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
    await plan.click('[data-testid="role-listener"]');
    await plan.type('[data-testid="your-name"]', 'Tester Listener');
    await clickText(plan, 'button[type=submit]', 'Continue as listener');
    await plan.waitForSelector('[data-testid="portal-code"]', { timeout: 8000 });
    check('A listener is asked for a plan first', plan.url().endsWith('/subscribe'), plan.url());
    const listenerMenu = await plan.$$eval('nav[aria-label="Main"] a', (links) => [...new Set(links.map((l) => l.textContent?.trim()))]);
    check('The listener menu is only listening: Home, Search, Library, Plan and Account', listenerMenu.join(',') === 'Home,Search,Library,Plan,Account', listenerMenu.join(','));
    await plan.goto(`${BASE}/share`, { waitUntil: 'networkidle2' });
    await sleep(300);
    check('A listener can’t open the contributor screen', !plan.url().endsWith('/share'), plan.url());
    await plan.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
    await sleep(500);
    check('Without a plan, Home sends them back to Plan', plan.url().endsWith('/subscribe'), plan.url());
    check('The buy buttons are disabled with payments off', await plan.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Buy monthly')) as HTMLButtonElement).disabled));
    await plan.type('[data-testid="portal-code"]', 'nope');
    await plan.keyboard.press('Enter');
    await plan.waitForSelector('[data-testid="portal-error"]', { timeout: 5000 });
    check('A wrong code shows an error', (await plan.$eval('[data-testid="portal-error"]', (e) => e.textContent ?? '')) === 'That code isn\u2019t valid.');
    await plan.click('[data-testid="portal-code"]', { clickCount: 3 });
    await plan.keyboard.press('Backspace');
    await plan.type('[data-testid="portal-code"]', 'admin');
    await plan.keyboard.press('Enter');
    await plan.waitForFunction(() => location.pathname === '/', { timeout: 8000 });
    check('The code admin gives the plan and opens the music', true);
    const planNow = await plan.evaluate(async () => {
      const { token } = JSON.parse(localStorage.getItem('peerbeats.session')!);
      return (await (await fetch('/api/subscription', { headers: { Authorization: 'Bearer ' + token } })).json()).access;
    });
    check('It is a monthly plan', planNow.plan === 'monthly' && planNow.active, JSON.stringify(planNow));
    await plan.waitForSelector('main li button');
    await plan.evaluate(() => (document.querySelector('main li button') as HTMLElement).click());
    await sleep(1500);
    check('The new listener is past the paywall', (await plan.$('[data-testid="player-error"]')) === null);
    await plan.close();
    await fresh2.close();

    console.log('\n  Installing and offline');
    const app = await browser.newPage();
    watch(app);
    await app.goto(`${BASE}/?as=listener&go=%2F`, { waitUntil: 'networkidle2' });
    await app.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await sleep(800);
    // On its own page: this debugging call stops Chrome reporting offline correctly on that page.
    const installCheck = await browser.newPage();
    await installCheck.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
    const cdp = await installCheck.createCDPSession();
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    check('Chrome reports the app as installable', installabilityErrors.length === 0, installabilityErrors.map((e: any) => e.errorId).join(', '));
    await installCheck.close();
    await app.bringToFront();
    await app.reload({ waitUntil: 'networkidle2' });
    await app.waitForSelector('main li button');
    // Ask for something sensitive while the worker is in charge, then look through its caches.
    await app.evaluate(async (id) => {
      const { token } = JSON.parse(sessionStorage.getItem('peerbeats.session')!);
      await fetch(`/api/tracks/${id}/manifest?prefetch=1`, { headers: { Authorization: `Bearer ${token}` } });
    }, t0.id);
    const cached: string[] = await app.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
      }
      return urls;
    });
    check('The app itself is stored for offline use', cached.some((u) => u.includes('index.html')) && cached.some((u) => u.endsWith('.js')), `${cached.length} files`);
    check('No music, keys or account data are stored', !cached.some((u) => /^\/(api|seeder|socket\.io)/.test(u)));
    await app.setOfflineMode(true);
    await app.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSelector('[data-testid="connection-banner"]', { timeout: 6000 });
    const offlineText = await app.$eval('[data-testid="connection-banner"]', (e) => e.textContent ?? '');
    const onLineFlag = await app.evaluate(() => navigator.onLine);
    const shellOpen = await app.evaluate(() => Boolean(document.querySelector('main')));
    check('Offline, the app still opens and says it is offline', shellOpen && offlineText.includes('offline'), `onLine=${onLineFlag} text=${offlineText}`);
    await app.setOfflineMode(false);
    await app.reload({ waitUntil: 'networkidle2' });
    await app.waitForSelector('main li button');
    check('Back online, it works again', (await app.$('[data-testid="connection-banner"]')) === null);

    console.log('\n  The server going away');
    await stopServer();
    await app.waitForSelector('[data-testid="connection-banner"]', { timeout: 15000 });
    check('It tells the listener it cannot reach PeerBeats', (await app.$eval('[data-testid="connection-banner"]', (e) => e.textContent ?? '')).includes('Can’t reach'));
    await startServer();
    await app.waitForFunction(() => !document.querySelector('[data-testid="connection-banner"]'), { timeout: 20000, polling: 300 });
    check('It recovers by itself when the server returns', true);
    check('No script errors on any page', errors.length === 0, errors.slice(0, 3).join(' | '));

    console.log('\n  The settings file');
  const saved = await fetch(`${BASE}/api/lab/payment-keys`, {
    method: 'POST',
    headers: { 'X-PeerBeats-Lab': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId: 'rzp_test_Abc123', keySecret: 'Secret12345678' }),
  });
  check('Keys can be saved', saved.status === 200);
  const mode = (fs.statSync(env.PEERBEATS_ENV_FILE).mode & 0o777).toString(8);
  check('After saving secrets, only the owner can read the file', mode === '600', mode);
  check('Stage shows as 5', (await call('GET', '/api/lab/status')).data.stage === 5);

    console.log('\n  Two phones that can’t connect directly');
    // What most mobile networks do: no direct connection is possible, so only the relay is left.
    await stopServer();
    process.env.FORCE_RELAY = 'true';
    await startServer();
    const giverContext = await browser.createBrowserContext();
    const giverPage = await giverContext.newPage();
    watch(giverPage);
    await giverPage.goto(`${BASE}/?as=contributor.a&go=${encodeURIComponent('/share?autostart=1')}`, { waitUntil: 'networkidle2' });
    let holding = { chunks: 0, total: -1 };
    for (let i = 0; i < 80 && holding.chunks !== holding.total; i++) {
      await sleep(500);
      const { network } = (await call('GET', '/api/lab/status')).data;
      holding = { chunks: network.peers[0]?.chunks ?? 0, total: network.totalChunks };
    }
    check('The contributor holds every segment', holding.chunks === holding.total && holding.total > 0, `${holding.chunks} of ${holding.total}`);
    const hearerContext = await browser.createBrowserContext();
    const hearerPage = await hearerContext.newPage();
    watch(hearerPage);
    await hearerPage.goto(`${BASE}/?as=listener&go=%2F`, { waitUntil: 'networkidle2' });
    await hearerPage.waitForSelector('main li button');
    await hearerPage.evaluate(() => (document.querySelector('main li button') as HTMLElement).click());
    let heard = 0;
    for (let i = 0; i < 40 && heard < 3; i++) {
      await sleep(500);
      heard = await hearerPage.evaluate(() => document.querySelector('audio')?.currentTime ?? 0);
    }
    check('The music plays anyway', heard >= 3, `${heard.toFixed(1)} s`);
    await hearerPage.evaluate(() => (document.querySelector('button[aria-label="Toggle debug panel"]') as HTMLElement).click());
    await hearerPage.waitForSelector('[data-testid="chunk-row"]');
    const relayRows = await hearerPage.evaluate(() =>
      [...document.querySelectorAll('[data-testid="chunk-row"]')].map((row) => ({ source: row.children[1].textContent ?? '', result: row.children[4].textContent ?? '' })),
    );
    check('Every segment came from the contributor, through the relay', relayRows.length > 0 && relayRows.every((row) => row.source.startsWith('Contributor A') && row.source.includes('(relayed)')), relayRows[0]?.source);
    check('Every one still passed its hash check', relayRows.every((row) => row.result.startsWith('Hash OK')), relayRows.map((row) => row.result).find((r) => !r.startsWith('Hash OK')) ?? '');
    const watcher: Socket = io(BASE, { auth: { token: await login('admin') }, transports: ['websocket'], reconnection: false });
    const relayTotals = await new Promise<{ relayedBytes: number; peerBytes: number; seededBytes: number } | null>((resolve) => {
      setTimeout(() => resolve(null), 5000);
      watcher.once('admin:network', (snapshot: { totals: { relayedBytes: number; peerBytes: number; seededBytes: number } }) => resolve(snapshot.totals));
      watcher.once('connect', () => watcher.emit('admin:watch'));
    });
    watcher.close();
    check('The Monitor shows what the relay passed on', (relayTotals?.relayedBytes ?? 0) > 0, relayTotals?.relayedBytes);
    check('The contributor is credited for it, like any delivery', (relayTotals?.peerBytes ?? 0) > 0, relayTotals?.peerBytes);
    await giverPage.close();
    let chip = '';
    for (let i = 0; i < 30 && chip !== 'no contributors'; i++) {
      await sleep(500);
      chip = await hearerPage.evaluate(() => document.querySelector('[data-testid="delivered-by"]')?.textContent ?? '');
    }
    check('When that contributor leaves, the listener is told at once', chip === 'no contributors', chip);
    await hearerPage.close();
    await giverContext.close();
    await hearerContext.close();
    delete process.env.FORCE_RELAY;

    console.log('\n  With demo mode off, as at launch');
    await stopServer();
    process.env.DEMO_MODE = 'false';
    process.env.REJECT_SHARED_IP = '';
    await startServer();
    check('The Lab controls are gone', (await call('GET', '/api/lab/status')).status === 404);
    check('No server tool for damaging files', (await call('POST', '/api/dev/tamper', admin, {})).status === 404);
    const live = await browser.newPage();
    watch(live);
    // Earlier pages in this browser left a saved login, and this check needs the login page.
    await live.goto(`${BASE}/login-check`, { waitUntil: 'domcontentloaded' });
    await live.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await live.goto(`${BASE}/lab`, { waitUntil: 'networkidle2' });
    await sleep(500);
    const landing = await live.evaluate(() => ({ path: location.pathname, text: document.body.innerText }));
    check('The Lab page redirects away', landing.path === '/', landing.path);
    check('Login shows no demo accounts', landing.text.includes('Log in') && !/demo accounts/i.test(landing.text));
    await live.evaluate((token) => sessionStorage.setItem('peerbeats.session', JSON.stringify({ token, user: { id: 'x', email: 'x', displayName: 'Other Person', isContributor: false, isAdmin: false } })), other);
    await live.goto(`${BASE}/share`, { waitUntil: 'networkidle2' });
    await sleep(500);
    const liveShare = await live.evaluate(() => document.body.innerText);
    check('No Back to Lab button', !liveShare.includes('Back to Lab'));
    await live.goto(`${BASE}/subscribe`, { waitUntil: 'networkidle2' });
    await sleep(500);
    check('No code box', (await live.$('[data-testid="portal-code"]')) === null);
    check('The free-plan code route is gone', (await call('POST', '/api/payments/code', admin, { code: 'admin' })).status === 404);
    await live.close();
    check('The portal code route is gone', (await call('POST', '/api/payments/portal', admin, { code: 'admin' })).status === 404);
    check('The test checkout route is gone', (await call('POST', '/api/payments/portal/pay', admin, { plan: 'monthly' })).status === 404);
    check('The same-network rule is on', (await call('GET', '/api/admin/revenue', admin)).data.rules.rejectSharedIp === true);
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  finish(failed ? 1 : 0);
} catch (err) {
  console.error('The test crashed:', err);
  finish(2);
}
