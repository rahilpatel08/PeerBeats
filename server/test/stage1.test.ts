/**
 * Stage 1 acceptance test against a running server:
 *   npm run test:stage1
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { io } from 'socket.io-client';
import { config } from '../src/config.js';
import { chunkPath } from '../src/seeder/storage.js';

const BASE = process.env.PEERBEATS_URL || `http://localhost:${config.port}`;
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`);
}

async function http(url: string, token?: string, init: RequestInit = {}) {
  return fetch(BASE + url, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
const post = (url: string, body: unknown, token?: string) => http(url, token, { method: 'POST', body: JSON.stringify(body) });
const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const bytesOf = async (url: string, token: string) => Buffer.from(await (await http(url, token)).arrayBuffer());

function decrypt(bytes: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
}

const health = await http('/api/health').catch(() => null);
if (!health?.ok) {
  console.error(`No server at ${BASE}. Double-click "Start PeerBeats.command" first.`);
  process.exit(1);
}

console.log('\nAuthentication');
const email = `test-${Date.now()}@peerbeats.test`;
const signup = await post('/api/auth/signup', { email, password: 'longenough1', displayName: 'Test User' });
check('Sign up creates an account', signup.status === 201);
check('Duplicate email is refused', (await post('/api/auth/signup', { email, password: 'longenough1', displayName: 'X' })).status === 409);
check('Short password is refused', (await post('/api/auth/signup', { email: `b${email}`, password: 'short', displayName: 'X' })).status === 400);
check('Wrong password is refused', (await post('/api/auth/login', { email, password: 'wrong-password' })).status === 401);
const login = await post('/api/auth/login', { email: 'listener@peerbeats.test', password: 'demo1234' });
check('Demo listener can log in', login.status === 200);
const { token } = await login.json();
check('GET /api/me returns the user', (await (await http('/api/me', token)).json()).user?.email === 'listener@peerbeats.test');
check('Catalog needs a login', (await http('/api/tracks')).status === 401);

console.log('\nCatalog and search');
const all = (await (await http('/api/tracks', token)).json()).tracks;
check('20 seed tracks are listed', all.length === 20, `got ${all.length}`);
check('Every track has a license', all.every((t: any) => t.license === 'CC0'));
check('Catalog listing never contains keys', !JSON.stringify(all).includes('"key"'));
const found = (await (await http('/api/tracks?query=rain', token)).json()).tracks;
check('Search finds "Rain on Tin"', found.length === 1 && found[0].title === 'Rain on Tin');
const lofi = (await (await http('/api/tracks?genre=Lo-Fi', token)).json()).tracks;
check('Genre filter works', lofi.length === 4 && lofi.every((t: any) => t.genre === 'Lo-Fi'));
const wild = (await (await http('/api/tracks?query=%25', token)).json()).tracks;
check('Search treats % as plain text', wild.length === 0);
check('Popular endpoint responds', (await http('/api/tracks/popular', token)).status === 200);

console.log('\nManifest, seeder and encryption');
const trackId = found[0].id;
check('Manifest needs a login', (await http(`/api/tracks/${trackId}/manifest`)).status === 401);
const manifest = await (await http(`/api/tracks/${trackId}/manifest`, token)).json();
const key = Buffer.from(manifest.key, 'base64');
check('Manifest has the init segment and every media segment', manifest.chunks.length === found[0].segmentCount + 1);
check('Track key is 256 bits', key.length === 32);
const media = manifest.chunks.slice(1);
const gaps = media.slice(1).map((c: any, i: number) => c.start - media[i].start);
check('Media segments are about 5 seconds', gaps.every((g: number) => g > 4.8 && g < 5.2), gaps.join(','));
check('Seeder needs a login', (await http(`/seeder/chunks/${manifest.chunks[0].id}`)).status === 401);
check('A listener is refused music by the server', (await http(`/seeder/chunks/${manifest.chunks[0].id}`, token)).status === 403);

// The server only supplies contributors who are sharing, so register as one and store everything.
const contributorLogin = await post('/api/auth/login', { email: 'contributor.a@peerbeats.test', password: 'demo1234' });
const contributorToken = (await contributorLogin.json()).token;
check('A contributor who is not sharing is refused', (await http(`/seeder/chunks/${manifest.chunks[0].id}`, contributorToken)).status === 403);
const socket = io(BASE, { auth: { token: contributorToken }, transports: ['websocket'], reconnection: false });
await new Promise<void>((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});
await new Promise((resolve) => socket.emit('peer:hello', { quotaMb: 2048 }, resolve));
const assigned = new Set<string>();
for (let round = 0; round < 40; round++) {
  const reply = new Promise<{ chunks: { id: string }[] }>((resolve) => socket.once('peer:assign', resolve));
  socket.emit('peer:have', { chunkIds: [...assigned] });
  const { chunks } = await reply;
  if (!chunks.length) break;
  chunks.forEach((c) => assigned.add(c.id));
}
check('The tracker assigned this track to the contributor', manifest.chunks.every((c: any) => assigned.has(c.id)));
check('Malformed chunk id is refused', (await http('/seeder/chunks/..%2F..%2Fetc', contributorToken)).status === 400);

let allHashesMatch = true;
let encryptedAtRest = true;
const plain: Buffer[] = [];
for (const chunk of manifest.chunks) {
  const bytes = await bytesOf(`/seeder/chunks/${chunk.id}`, contributorToken);
  if (hash(bytes) !== chunk.sha256 || bytes.length !== chunk.size) allHashesMatch = false;
  if (bytes.includes(Buffer.from('ftyp')) || bytes.includes(Buffer.from('moof'))) encryptedAtRest = false;
  plain.push(decrypt(bytes, key));
}
check('Every segment matches its SHA-256', allHashesMatch);
check('Stored bytes show no MP4 structure (really encrypted)', encryptedAtRest);
check('Decrypted init segment is an MP4 header', plain[0].includes(Buffer.from('ftyp')));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'peerbeats-test-'));
const joined = path.join(work, 'track.mp4');
fs.writeFileSync(joined, Buffer.concat(plain));
const decode = spawnSync(ffmpegPath as unknown as string, ['-v', 'error', '-i', joined, '-f', 'null', '-'], { encoding: 'utf8' });
fs.rmSync(work, { recursive: true, force: true });
check('Decrypted segments decode as clean audio', decode.status === 0 && !decode.stderr.trim(), decode.stderr.slice(0, 200));

console.log('\nTamper detection and recovery');
const victim = media[2];
// Damage the stored file on disk directly, as a failing disk would. The server offers no way to.
const victimFile = chunkPath('hot', trackId, victim.idx);
const reachable = fs.existsSync(victimFile);
check('The test can reach the server\'s storage', reachable, reachable ? '' : 'set PEERBEATS_STORAGE_DIR to the server\'s storage folder');
if (reachable) {
  const bytes = fs.readFileSync(victimFile);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(victimFile, bytes);
}
check('There is no server tool for damaging files', (await post('/api/dev/tamper', { trackId, idx: victim.idx }, contributorToken)).status === 404);
const damaged = await bytesOf(`/seeder/chunks/${victim.id}`, contributorToken);
check('Damaged segment fails the hash check', hash(damaged) !== victim.sha256);
let decryptRefused = false;
try {
  decrypt(damaged, key);
} catch {
  decryptRefused = true;
}
check('AES-GCM also refuses the damaged bytes', decryptRefused);
const fromOrigin = await bytesOf(`/seeder/chunks/${victim.id}?tier=origin`, contributorToken);
check('Origin copy passes the hash check', hash(fromOrigin) === victim.sha256);
const healed = await bytesOf(`/seeder/chunks/${victim.id}`, contributorToken);
check('Stored copy was repaired automatically', hash(healed) === victim.sha256);

socket.disconnect();
await new Promise((resolve) => setTimeout(resolve, 200));
check('Once it stops sharing, the server refuses it too', (await http(`/seeder/chunks/${victim.id}`, contributorToken)).status === 403);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
