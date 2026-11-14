/**
 * Stage 2 acceptance test against a running server: tracker, signaling and lab controls.
 * Real WebRTC transfers need browsers, so those are tested from the Lab page.
 *   npm run test:stage2
 */
import http from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { config } from '../src/config.js';

const BASE = process.env.PEERBEATS_URL || `http://localhost:${config.port}`;
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`);
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  });
  return (await res.json()).token;
}

const connect = (token: string) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

const once = <T = any>(socket: Socket, event: string, ms = 3000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${event}`)), ms);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

const hello = (socket: Socket, quotaMb = 200) =>
  new Promise<{ peerSessionId?: string; error?: string }>((resolve) => socket.emit('peer:hello', { quotaMb }, resolve));

const network = async (token: string) => (await fetch(`${BASE}/api/admin/network`, { headers: { Authorization: `Bearer ${token}` } })).json();

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No server at ${BASE}. Double-click "Start PeerBeats.command" first.`);
  process.exit(1);
}

const [listenerToken, contributorToken, otherToken, adminToken] = await Promise.all([
  login('listener@peerbeats.test'),
  login('contributor.a@peerbeats.test'),
  login('contributor.b@peerbeats.test'),
  login('admin@peerbeats.test'),
]);

console.log('\nConnections');
let refused = false;
try {
  (await connect('not-a-real-token')).disconnect();
} catch {
  refused = true;
}
check('A socket without a valid login is refused', refused);
const listener = await connect(listenerToken);
const contributor = await connect(contributorToken);
const other = await connect(otherToken);
check('Logged-in users can connect', listener.connected && contributor.connected && other.connected);

console.log('\nPeer registration and assignment');
const notAllowed = await hello(listener);
check('A user who has not opted in cannot register as a peer', Boolean(notAllowed.error));
const { peerSessionId } = await hello(contributor);
check('An opted-in contributor gets a peer session', Boolean(peerSessionId));
const firstAssign = once(contributor, 'peer:assign');
contributor.emit('peer:have', { chunkIds: [] });
const { chunks } = await firstAssign;
check('Tracker assigns chunks to store', chunks.length > 0);
check('Assignment includes hashes for verifying', chunks.every((c: any) => /^[0-9a-f]{64}$/.test(c.sha256)));
check('Assignment contains no decryption key', !JSON.stringify(chunks).toLowerCase().includes('key'));

console.log('\nPeers-only delivery');
const assignedChunk = chunks[0].id;
const unassignedChunk = await (async () => {
  const tracks = (await (await fetch(`${BASE}/api/tracks`, { headers: { Authorization: `Bearer ${listenerToken}` } })).json()).tracks;
  for (const t of tracks) {
    const m = await (await fetch(`${BASE}/api/tracks/${t.id}/manifest?prefetch=1`, { headers: { Authorization: `Bearer ${listenerToken}` } })).json();
    const other = m.chunks.find((c: any) => !chunks.some((a: any) => a.id === c.id));
    if (other) return other.id;
  }
  throw new Error('No unassigned chunk');
})();
const seeder = (id: string, token: string) => fetch(`${BASE}/seeder/chunks/${id}`, { headers: { Authorization: `Bearer ${token}` } });
check('Server refuses to send music to a listener', (await seeder(assignedChunk, listenerToken)).status === 403);
check('Origin copy is refused to a listener too', (await fetch(`${BASE}/seeder/chunks/${assignedChunk}?tier=origin`, { headers: { Authorization: `Bearer ${listenerToken}` } })).status === 403);
check('Server supplies a chunk the contributor was assigned', (await seeder(assignedChunk, contributorToken)).status === 200);
check('Server refuses a chunk the contributor was not assigned', (await seeder(unassignedChunk, contributorToken)).status === 403);

const replyToBad = once(contributor, 'tracker:error');
contributor.emit('peer:have', { chunkIds: ['not-a-uuid'] });
check('A malformed report is refused without a crash', Boolean(await replyToBad));

const secondAssign = once(contributor, 'peer:assign');
contributor.emit('peer:have', { chunkIds: [...chunks.map((c: any) => c.id), '00000000-0000-4000-8000-000000000000'] });
const next = await secondAssign;
check('The next batch skips what the peer already holds', !next.chunks.some((c: any) => chunks.some((h: any) => h.id === c.id)));

const before = await network(adminToken);
const me = before.peers.find((p: any) => p.sessionId === peerSessionId);
check('A fake chunk id is not recorded', me?.chunks === chunks.length, `stored ${me?.chunks}`);

console.log('\nFinding peers for playback');
const tracks = (await (await fetch(`${BASE}/api/tracks`, { headers: { Authorization: `Bearer ${listenerToken}` } })).json()).tracks;
const manifests = await Promise.all(
  tracks.map(async (t: any) => ({
    id: t.id,
    manifest: await (await fetch(`${BASE}/api/tracks/${t.id}/manifest?prefetch=1`, { headers: { Authorization: `Bearer ${listenerToken}` } })).json(),
  })),
);
const held = new Set(chunks.slice(0, 5).map((c: any) => c.id));
const heldTrack = manifests.find((m) => m.manifest.chunks.some((c: any) => held.has(c.id)))!;
const heldIdx = heldTrack.manifest.chunks.find((c: any) => held.has(c.id)).idx;

const reply = once(listener, 'play:peers');
listener.emit('play:request', { trackId: heldTrack.id, fromIdx: 0 });
const peers = await reply;
check('Listener is told which peer holds a segment', peers.peers[heldIdx]?.includes(peerSessionId));
check('Peer name is provided for the debug panel', peers.names[peerSessionId!] === 'Contributor A');

const selfReply = once(contributor, 'play:peers');
contributor.emit('play:request', { trackId: heldTrack.id, fromIdx: 0 });
const self = await selfReply;
check('Peers are never offered their own copy', !Object.values(self.peers).flat().includes(peerSessionId));

console.log('\nSignaling');
const offer = once(contributor, 'signal:offer');
listener.emit('signal:offer', { to: peerSessionId, sdp: 'test-offer' });
const gotOffer = await offer;
check('Offer reaches the contributor', gotOffer.sdp === 'test-offer' && gotOffer.from === listener.id);
const answer = once(listener, 'signal:answer');
contributor.emit('signal:answer', { to: listener.id, sdp: 'test-answer' });
const gotAnswer = await answer;
check('Answer reaches the listener with the peer session id', gotAnswer.sdp === 'test-answer' && gotAnswer.from === peerSessionId);
const iceOut = once(contributor, 'signal:ice');
listener.emit('signal:ice', { to: peerSessionId, kind: 'listener', candidate: { candidate: 'x' } });
check('ICE reaches the contributor', (await iceOut).kind === 'listener');
const iceBack = once(listener, 'signal:ice');
contributor.emit('signal:ice', { to: listener.id, kind: 'contributor', candidate: { candidate: 'y' } });
check('ICE reaches the listener', (await iceBack).from === peerSessionId);

console.log('\nMonitor');
const heldChunk = heldTrack.manifest.chunks.find((c: any) => c.idx === heldIdx);
const accepted: any = await new Promise((resolve) => listener.emit('receipt:confirm', { chunkId: heldChunk.id, peerSessionId, latencyMs: 9 }, resolve));
check('A verified receipt is accepted', accepted.accepted === true, accepted.reason ?? '');
const after = await network(adminToken);
check('It reaches the monitor', after.totals.peerBytes === before.totals.peerBytes + heldChunk.size);
check('Monitor credits the right peer, using the real size', after.peers.find((p: any) => p.sessionId === peerSessionId)?.servedBytes === heldChunk.size);
check('Monitor shows an active transfer', after.transfers.some((t: any) => t.from === peerSessionId && t.to === listener.id));
check('A listener who starts a track shows as waiting', after.listeners.find((l: any) => l.socketId === listener.id)?.state === 'waiting');
listener.emit('play:status', { state: 'playing' });
await new Promise((resolve) => setTimeout(resolve, 100));
check('...then playing', (await network(adminToken)).listeners.find((l: any) => l.socketId === listener.id)?.state === 'playing');
listener.emit('play:status', { state: 'paused' });
await new Promise((resolve) => setTimeout(resolve, 100));
check('...and paused is not reported as active', (await network(adminToken)).listeners.find((l: any) => l.socketId === listener.id)?.state === 'paused');
check('Non-admins cannot read the network', (await fetch(`${BASE}/api/admin/network`, { headers: { Authorization: `Bearer ${listenerToken}` } })).status === 403);
const watch = once(other, 'admin:network', 1500).catch(() => null);
other.emit('admin:watch');
check('Non-admins cannot watch the live feed', (await watch) === null);

contributor.emit('peer:bye');
await new Promise((resolve) => setTimeout(resolve, 150));
check('A peer that stops sharing leaves the network', !(await network(adminToken)).peers.some((p: any) => p.sessionId === peerSessionId));

const { peerSessionId: second } = await hello(other);
other.disconnect();
await new Promise((resolve) => setTimeout(resolve, 300));
const finalNet = await network(adminToken);
check('A closed tab leaves the network at once', Boolean(second) && !finalNet.peers.some((p: any) => p.sessionId === second));
const noPeers = once(listener, 'play:peers');
listener.emit('play:request', { trackId: heldTrack.id, fromIdx: 0 });
check('Its copies are no longer offered to listeners', !Object.values((await noPeers).peers).flat().includes(second));

console.log('\nLab controls');
const asPhone = await fetch(`${BASE}/api/lab/status`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
check('A phone link visitor is refused the Lab', asPhone.status === 403, String(asPhone.status));
const tunnel = (headers: Record<string, string>) => fetch(`${BASE}/api/lab/link/new`, { method: 'POST', headers });
check('Phone link controls refuse requests through the link', (await tunnel({ 'X-PeerBeats-Lab': '1', 'CF-Connecting-IP': '203.0.113.9' })).status === 403);
check('Phone link controls refuse other websites (no lab header)', (await tunnel({})).status === 403);
// fetch ignores a custom Host header, so this one needs a raw request.
const foreignHost = await new Promise<number>((resolve, reject) => {
  const url = new URL(BASE);
  const req = http.request(
    { hostname: url.hostname, port: url.port, path: '/api/lab/link/new', method: 'POST', headers: { 'X-PeerBeats-Lab': '1', Host: 'evil.example' } },
    (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    },
  );
  req.on('error', reject);
  req.end();
});
check('Phone link controls refuse a foreign Host name', foreignHost === 403, `got ${foreignHost}`);
const linkNow = (await (await fetch(`${BASE}/api/lab/status`)).json()).link.state;
// This test server runs with the phone link off, so anything else means one of those got through.
check('None of those requests started a phone link', linkNow === 'off', `state ${linkNow}`);
const demoFromPhone = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
  body: JSON.stringify({ email: 'admin@peerbeats.test', password: 'demo1234' }),
});
check('Demo accounts, the admin included, can’t be used through the phone link', demoFromPhone.status === 403, String(demoFromPhone.status));
check('RTC settings need a login', (await fetch(`${BASE}/api/rtc-config`)).status === 401);
const rtc = await (await fetch(`${BASE}/api/rtc-config`, { headers: { Authorization: `Bearer ${listenerToken}` } })).json();
check('RTC settings include the STUN server', rtc.iceServers[0].urls === 'stun:stun.l.google.com:19302');

listener.disconnect();
contributor.disconnect();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
