/**
 * Stage 3 acceptance test against a running server: replication, scoring and heartbeats.
 * Stop any contributors first, since it counts every copy on the network. Takes about 90 s.
 *   npm run test:stage3
 */
import { io, type Socket } from 'socket.io-client';
import { config } from '../src/config.js';

const BASE = process.env.PEERBEATS_URL || `http://localhost:${config.port}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: unknown = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  [${detail}]` : ''}`);
}

const json = (url: string, token?: string, body?: unknown) =>
  fetch(BASE + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json());

const login = async (email: string): Promise<string> => (await json('/api/auth/login', undefined, { email, password: 'demo1234' })).token;

/** A contributor that speaks the real protocol and "stores" whatever it is assigned. */
class FakePeer {
  socket!: Socket;
  sessionId = '';
  held = new Map<string, number>();
  batches: { id: string; size: number }[][] = [];
  autoStore = true;
  answersHeartbeat = true;
  removed: string | null = null;

  constructor(readonly name: string, readonly token: string) {}

  async join(quotaMb = 2048) {
    this.socket = io(BASE, { auth: { token: this.token }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('connect_error', reject);
    });
    this.socket.on('peer:ping', () => {
      if (this.answersHeartbeat) this.socket.emit('peer:heartbeat');
    });
    this.socket.on('peer:removed', (data) => {
      this.removed = data.reason;
    });
    this.socket.on('peer:assign', ({ chunks }) => {
      if (chunks.length) this.batches.push(chunks);
      if (this.autoStore) this.store(chunks);
    });
    const reply: any = await new Promise((resolve) => this.socket.emit('peer:hello', { quotaMb }, resolve));
    this.sessionId = reply.peerSessionId;
    this.socket.emit('peer:have', { chunkIds: [] });
  }

  store(chunks: { id: string; size: number }[]) {
    if (!chunks.length) return;
    chunks.forEach((c) => this.held.set(c.id, c.size));
    this.socket.emit('peer:have', { chunkIds: chunks.map((c) => c.id) });
  }

  leave() {
    this.socket.disconnect();
  }
}

async function makePeer(n: number): Promise<FakePeer> {
  const email = `test-${Date.now()}-${n}@peerbeats.test`;
  const { token } = await json('/api/auth/signup', undefined, { email, password: 'longenough1', displayName: `Test Peer ${n}` });
  await json('/api/me/contributor', token, { enabled: true });
  return new FakePeer(`Test Peer ${n}`, token);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No server at ${BASE}. Double-click "Start PeerBeats.command" first.`);
  process.exit(1);
}

const adminToken = await login('admin@peerbeats.test');
const listenerToken = await login('listener@peerbeats.test');
const network = () => json('/api/admin/network', adminToken);
const totalCopies = async () => (await network()).peers.reduce((sum: number, p: any) => sum + p.chunks, 0);
const minReplicas = async () => Math.min(...(await network()).tracks.map((t: any) => t.minReplicas));

async function waitFor(test: () => Promise<boolean>, ms: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await test()) return Date.now() - started;
    await sleep(100);
  }
  return null;
}

const start = await network();
if (start.peers.length) {
  console.error('Stop all contributors first: this test counts every copy on the network.');
  process.exit(1);
}
const { tracks } = await json('/api/tracks', listenerToken);
const manifests = await Promise.all(tracks.map((t: any) => json(`/api/tracks/${t.id}/manifest?prefetch=1`, listenerToken)));
const totalChunks = manifests.reduce((sum: number, m: any) => sum + m.chunks.length, 0);
const TARGET = start.replicationTarget;

console.log('\nAssigning work');
// Make one track clearly the most popular.
const popular = (await json('/api/tracks/popular', listenerToken)).tracks;
const favourite = tracks[tracks.length - 1];
for (let i = 0; i <= (popular[0]?.playCount ?? 0); i++) await json(`/api/tracks/${favourite.id}/manifest`, listenerToken);

// One more peer than copies needed, so a lost peer's work has somewhere to go.
const peers = await Promise.all(Array.from({ length: TARGET + 1 }, (_, i) => makePeer(i + 1)));
peers.forEach((p) => (p.autoStore = false));
await Promise.all(peers.map((p) => p.join()));
await sleep(500);
const favouriteChunks = new Set(manifests.find((m: any) => m.track.id === favourite.id).chunks.map((c: any) => c.id));
// Peers join in no fixed order, so the rule is about the network: the first copies made
// anywhere are of the favourite, until it has its full 3, and only then does other work start.
const firstBatches = peers.map((p) => p.batches[0] ?? []);
const startsWithFavourite = firstBatches.filter((batch) => batch.length > 0 && batch.slice(0, favouriteChunks.size).every((c) => favouriteChunks.has(c.id)));
check(`The most popular track goes first, to ${TARGET} peers`, startsWithFavourite.length === TARGET, `${startsWithFavourite.length} of ${peers.length} peers started with it`);
const counts = new Map<string, number>();
for (const peer of peers) for (const batch of peer.batches) for (const c of batch) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
check(`Peers joining together never exceed ${TARGET} copies of a chunk`, [...counts.values()].every((n) => n <= TARGET), `highest ${Math.max(...counts.values())}`);

console.log('\nReaching full replication');
peers.forEach((p) => {
  p.autoStore = true;
  for (const batch of p.batches) p.store(batch);
});
const filled = await waitFor(async () => (await minReplicas()) >= TARGET, 30000);
check(`Every chunk reaches ${TARGET} copies`, filled !== null, filled === null ? await minReplicas() : `${filled} ms`);
check('No chunk gets more than the target', (await totalCopies()) === totalChunks * TARGET, `${await totalCopies()} copies of ${totalChunks} chunks`);
check('Monitor shows every song healthy', (await network()).tracks.every((t: any) => t.health === 'green'));

console.log('\nRebuilding after a loss');
const victim = peers.sort((a, b) => b.held.size - a.held.size)[0];
const survivors = peers.filter((p) => p !== victim);
const lost = victim.held.size;
victim.leave();
const rebuilt = await waitFor(async () => (await minReplicas()) >= TARGET && (await totalCopies()) === totalChunks * TARGET, 30000);
check(`Losing a peer with ${lost} chunks restores ${TARGET} copies of everything`, rebuilt !== null, rebuilt === null ? await minReplicas() : `${rebuilt} ms`);
const eventsAfterLoss = (await network()).events.map((e: any) => e.text);
check('The monitor logs the loss', eventsAfterLoss.some((t: string) => t.includes(`${victim.name} disconnected`)));
check('The monitor logs the rebuild', eventsAfterLoss.some((t: string) => t.startsWith('Rebuilding lost copies')));

console.log('\nCopies no one can replace');
while (survivors.length > 2) survivors.pop()!.leave();
await waitFor(async () => (await network()).peers.length === 2, 3000);
await sleep(500);
check(`With 2 peers left, songs show as below target`, (await minReplicas()) === 2 && (await network()).tracks.every((t: any) => t.health === 'amber'));

const small = await makePeer(101);
await small.join(1);
const limit = 1024 * 1024;
await sleep(1000);
const smallBytes = [...small.held.values()].reduce((a, b) => a + b, 0);
check('A small quota is respected', smallBytes > 0 && smallBytes <= limit, `${(smallBytes / 1024).toFixed(0)} KB of ${limit / 1024} KB`);
small.leave();
await sleep(300);

console.log('\nRanking peers');
const [good, bad] = survivors;
const listener = io(BASE, { auth: { token: listenerToken }, transports: ['websocket'], reconnection: false });
await new Promise<void>((resolve) => listener.once('connect', () => resolve()));
const peersFor = (trackId: string) =>
  new Promise<any>((resolve) => {
    listener.once('play:peers', resolve);
    listener.emit('play:request', { trackId, fromIdx: 0 });
  });
const heldManifest = manifests.find((m: any) => m.chunks.filter((c: any) => good.held.has(c.id)).length >= 4);
const heldChunks = heldManifest.chunks.filter((c: any) => good.held.has(c.id)).slice(0, 4);
await peersFor(heldManifest.track.id);
for (let i = 0; i < 4; i++) listener.emit('stats:failure', { peerSessionId: bad.sessionId, reason: 'timeout' });
for (const c of heldChunks) listener.emit('receipt:confirm', { chunkId: c.id, peerSessionId: good.sessionId, latencyMs: 8 });
await sleep(300);
const after = await network();
const scoreOf = (p: FakePeer) => after.peers.find((x: any) => x.sessionId === p.sessionId);
check('Failures lower the success rate', scoreOf(bad).successPct < 50, `${scoreOf(bad).successPct}%`);
check('A healthy peer keeps its success rate', scoreOf(good).successPct === 100, `${scoreOf(good).successPct}%`);
const listing = await peersFor(tracks[0].id);
const firstChoice = Object.values<string[]>(listing.peers).map((ids) => ids[0]);
check('The tracker offers the better peer first', firstChoice.length > 0 && firstChoice.every((id) => id === good.sessionId));

good.socket.emit('play:request', { trackId: heldManifest.track.id, fromIdx: 0 });
good.socket.emit('receipt:confirm', { chunkId: heldChunks[0].id, peerSessionId: good.sessionId });
await sleep(150);
const selfVouch = (await network()).peers.find((x: any) => x.sessionId === good.sessionId);
check('A peer cannot report its own deliveries', selfVouch.servedBytes === scoreOf(good).servedBytes, selfVouch.servedBytes);

console.log('\nRemoving a bad peer');
// The listener has used 4 of its 6 reports this minute. Flooding must not get it any further.
for (let i = 0; i < 12; i++) listener.emit('stats:failure', { peerSessionId: bad.sessionId, reason: 'hash-mismatch' });
await sleep(300);
check('One listener alone cannot remove a contributor', bad.removed === null && (await network()).peers.some((p: any) => p.sessionId === bad.sessionId));
const removedOnce = new Promise((resolve) => bad.socket.once('peer:removed', resolve));
for (let i = 0; i < 3; i++) good.socket.emit('stats:failure', { peerSessionId: bad.sessionId, reason: 'hash-mismatch' });
await Promise.race([removedOnce, sleep(2000)]);
await sleep(200);
const afterBad = await network();
check('A peer serving damaged copies is told to rejoin', bad.removed === 'too many damaged copies', bad.removed ?? 'not told');
check('It stops being offered to listeners', !afterBad.peers.some((p: any) => p.sessionId === bad.sessionId));
check('The monitor explains why', afterBad.events[0].text.includes('damaged copies') || afterBad.events.some((e: any) => e.text.includes('served too many damaged')));
const relisting = await peersFor(tracks[0].id);
check('Its copies are no longer listed', !Object.values<string[]>(relisting.peers).flat().includes(bad.sessionId));

console.log('\nHeartbeats (about a minute)');
const silent = await makePeer(102);
await silent.join();
await sleep(500);
silent.answersHeartbeat = false;
const silenceStarted = Date.now();
const removedAfter = await waitFor(async () => !(await network()).peers.some((p: any) => p.sessionId === silent.sessionId), 80000);
const seconds = (Date.now() - silenceStarted) / 1000;
check('A connected peer that stops answering is removed', removedAfter !== null, `${seconds.toFixed(0)} s`);
check('...within the 45-60 s the design allows', seconds >= 44 && seconds <= 62, `${seconds.toFixed(0)} s`);
check('...and is told, so it can rejoin', silent.removed === 'no heartbeat', silent.removed ?? 'not told');
check('A peer that keeps answering stays', (await network()).peers.some((p: any) => p.sessionId === good.sessionId));

for (const p of [good, bad, silent]) p.socket.disconnect();
listener.disconnect();
await sleep(300);
check('Everyone leaving empties the network', (await network()).peers.length === 0);
check('Songs with no holders show as unplayable', (await network()).tracks.every((t: any) => t.health === 'red'));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
