/**
 * Stage 4 acceptance test. Runs a private copy of PeerBeats on temporary data with a fake
 * Razorpay API, so it needs no keys and can't touch real data. Signatures, webhooks,
 * gating, receipts and payouts all run the real code.
 *   npm run test:stage4
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, type Socket } from 'socket.io-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'peerbeats-stage4-'));
const PORT = 4299;
const GATEWAY_PORT = 4298;
const BASE = `http://localhost:${PORT}`;
const KEY_ID = 'rzp_test_FakeKeyForTests';
const KEY_SECRET = 'FakeSecretForTests123';
const WEBHOOK_SECRET = 'fake-webhook-secret';

const env: Record<string, string> = {
  PEERBEATS_DATA_DIR: path.join(work, 'data'),
  PEERBEATS_STORAGE_DIR: path.join(work, 'storage'),
  PEERBEATS_ENV_FILE: path.join(work, '.env'),
  JWT_SECRET: 'test-only-secret',
  PORT: String(PORT),
  DEMO_MODE: 'true',
  PHONE_LINK: 'off',
  DATABASE_URL: '',
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  RAZORPAY_WEBHOOK_SECRET: '',
  RAZORPAY_API_BASE: `http://localhost:${GATEWAY_PORT}`,
  CREDIT_PACK_CREDITS: '2',
  PAYOUT_CYCLE_SEC: '100000',
  REVENUE_CYCLES: '2',
  PAIR_CAP_MB_PER_HOUR: '0.3',
  LISTENER_CAP_MB_PER_HOUR: '0.5',
  REJECT_SHARED_IP: 'false',
};
Object.assign(process.env, env);
fs.writeFileSync(env.PEERBEATS_ENV_FILE, 'EXISTING_SETTING=keep-me\n');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: unknown = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  [${detail}]` : ''}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hmac = (message: string, secret: string) => crypto.createHmac('sha256', secret).update(message).digest('hex');

// ---------- a stand-in for api.razorpay.com
let orderCounter = 0;
let gatewayDown = false;
const seenOrders: any[] = [];
const gateway = http.createServer((req, res) => {
  const expected = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.authorization !== expected) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }));
  }
  if (gatewayDown) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: { code: 'SERVER_ERROR' } }));
  }
  if (req.method === 'GET') return res.end(JSON.stringify({ items: [] }));
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    seenOrders.push(parsed);
    res.end(JSON.stringify({ id: `order_fake${++orderCounter}`, entity: 'order', amount: parsed.amount, currency: parsed.currency, status: 'created' }));
  });
});
await new Promise<void>((resolve) => gateway.listen(GATEWAY_PORT, resolve));

// ---------- prepare the private database, with the server not yet running
const { openDb } = await import('../src/db.js');
const { ingestTrack } = await import('../scripts/ingest.js');
const { renderTrack } = await import('../scripts/synth.js');
const { grantMonthly } = await import('../src/payments/index.js');
const bcrypt = (await import('bcryptjs')).default;

const db = await openDb();
const hash = await bcrypt.hash('demo1234', 4);
const ACCOUNTS: [string, string, boolean, boolean][] = [
  ['admin', 'Lab Admin', false, true],
  ['con.a', 'Con A', true, false],
  ['con.b', 'Con B', true, false],
  ['paid', 'Already Paid', false, false],
  ['cap', 'Cap Listener', false, false],
  ['l2', 'Listener Two', false, false],
  ['l3', 'Listener Three', false, false],
  ['buyer', 'Buyer', false, false],
  ['hook', 'Hook Buyer', false, false],
  ['creditor', 'Credit Buyer', false, false],
  ['racer', 'Race Buyer', false, false],
  ['stranger', 'Stranger', false, false],
  ['new.listener', 'New Listener', false, false],
];
for (const [name, display, contributor, admin] of ACCOUNTS) {
  await db.query('insert into users (email, password_hash, display_name, is_contributor, is_admin) values ($1, $2, $3, $4, $5)', [
    `${name}@peerbeats.test`, hash, display, contributor, admin,
  ]);
}
for (const name of ['paid', 'cap', 'l2', 'l3']) {
  const { rows } = await db.query<{ id: string }>('select id from users where email = $1', [`${name}@peerbeats.test`]);
  await grantMonthly(db, rows[0].id);
}
for (let i = 0; i < 3; i++) {
  const wav = path.join(work, `${i}.wav`);
  fs.writeFileSync(wav, renderTrack({ genre: 'Chiptune', bpm: 150, root: 45, scale: 'major', progression: [0, 3, 4, 0], seed: 100 + i, targetSec: 20 }));
  await ingestTrack(db, { input: wav, title: `Track ${i}`, artist: 'Test', genre: 'Chiptune', license: 'CC0' });
}
await db.close();

let serverProcess: ChildProcess | null = null;
async function startServer(extra: Record<string, string> = {}) {
  serverProcess = spawn(path.join(SERVER_DIR, '..', 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...extra },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
    if (up) return;
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
setTimeout(() => {
  console.error('TIMED OUT');
  finish(3);
}, 180000).unref();

// Whatever goes wrong, never leave the private server running.
process.on('uncaughtException', (err) => {
  console.error('The test crashed:', err);
  finish(2);
});

const call = async (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const login = async (name: string): Promise<string> => (await call('POST', '/api/auth/login', undefined, { email: `${name}@peerbeats.test`, password: 'demo1234' })).data.token;

try {
  await startServer();
  const tokens: Record<string, string> = {};
  for (const [name] of ACCOUNTS) tokens[name] = await login(name);
  const tracks = (await call('GET', '/api/tracks', tokens.paid)).data.tracks;
  const manifest = (name: string, trackId: string, query = '') => call('GET', `/api/tracks/${trackId}/manifest${query}`, tokens[name]);
  const access = async (name: string) => (await call('GET', '/api/subscription', tokens[name])).data.access;
  const revenue = async () => (await call('GET', '/api/admin/revenue', tokens.admin)).data;
  const labHeaders: Record<string, string> = { 'X-PeerBeats-Lab': '1' };

  console.log('\nBefore keys are set up');
  const unset = await call('GET', '/api/subscription', tokens.buyer);
  check('Payments report as not set up', unset.data.configured === false);
  check('An order is refused, not faked', (await call('POST', '/api/payments/order', tokens.buyer, { plan: 'monthly' })).status === 503);

  console.log('\nAdding keys on the Lab page');
  const saveKeys = (keyId: string, keySecret: string, headers = labHeaders) =>
    call('POST', '/api/lab/payment-keys', undefined, { keyId, keySecret, webhookSecret: WEBHOOK_SECRET }, headers);
  check('A live key is refused', (await saveKeys('rzp_live_RealMoney123', KEY_SECRET)).status === 400);
  const wrong = await saveKeys(KEY_ID, 'WrongSecret12345');
  check('A key Razorpay rejects is refused', wrong.status === 400, wrong.data?.error);
  check('The form needs the lab header', (await saveKeys(KEY_ID, KEY_SECRET, {})).status === 403);
  check('It cannot be done through the phone link', (await saveKeys(KEY_ID, KEY_SECRET, { ...labHeaders, 'CF-Connecting-IP': '203.0.113.9' })).status === 403);
  const saved = await saveKeys(KEY_ID, KEY_SECRET);
  check('Good test keys are accepted', saved.status === 200 && saved.data.configured === true);
  const envFile = fs.readFileSync(env.PEERBEATS_ENV_FILE, 'utf8');
  check('They are saved to the settings file', envFile.includes(`RAZORPAY_KEY_SECRET=${KEY_SECRET}`) && envFile.includes(`RAZORPAY_KEY_ID=${KEY_ID}`));
  check('Existing settings are kept', envFile.includes('EXISTING_SETTING=keep-me'));
  const status = await call('GET', '/api/lab/status');
  check('The secret is never sent back', !JSON.stringify(status.data).includes(KEY_SECRET) && status.data.payments.configured === true);

  console.log('\nGating');
  const blocked = await manifest('buyer', tracks[0].id);
  check('Someone with no plan is refused the manifest', blocked.status === 402);
  check('...and is given no key', !JSON.stringify(blocked.data).includes('"key"'));
  check('A pre-fetch is refused too', (await manifest('buyer', tracks[0].id, '?prefetch=1')).status === 402);
  check('Someone with a plan gets it', (await manifest('paid', tracks[0].id)).status === 200);

  console.log('\nBuying a plan');
  check('An unknown plan is refused', (await call('POST', '/api/payments/order', tokens.buyer, { plan: 'free' })).status === 400);
  const order = await call('POST', '/api/payments/order', tokens.buyer, { plan: 'monthly', amount: 1 });
  check('The price comes from the server, not the browser', order.status === 200 && order.data.amount === 9900 && seenOrders.at(-1).amount === 9900, order.data?.amount);
  check('The order is sent in INR with a receipt under 40 characters', seenOrders.at(-1).currency === 'INR' && seenOrders.at(-1).receipt.length <= 40, seenOrders.at(-1).receipt?.length);
  const paymentId = 'pay_fake1';
  const sign = (orderId: string, payId: string) => hmac(`${orderId}|${payId}`, KEY_SECRET);
  const verify = (name: string, orderId: string, payId: string, signature: string) =>
    call('POST', '/api/payments/verify', tokens[name], { razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: signature });

  check('A forged signature is refused', (await verify('buyer', order.data.orderId, paymentId, 'f'.repeat(64))).status === 400);
  check('A signature for another payment is refused', (await verify('buyer', order.data.orderId, paymentId, sign(order.data.orderId, 'pay_other'))).status === 400);
  check('A signature made with the webhook secret is refused', (await verify('buyer', order.data.orderId, paymentId, hmac(`${order.data.orderId}|${paymentId}`, WEBHOOK_SECRET))).status === 400);
  check("Another person can't claim this payment", (await verify('stranger', order.data.orderId, paymentId, sign(order.data.orderId, paymentId))).status === 403);
  check('None of those activated anything', (await access('buyer')).active === false);

  const good = await verify('buyer', order.data.orderId, paymentId, sign(order.data.orderId, paymentId));
  check('A valid signature activates the plan', good.status === 200 && good.data.access.plan === 'monthly', good.data?.outcome);
  check('The buyer can now get the manifest', (await manifest('buyer', tracks[0].id)).status === 200);
  const endsAt = (await access('buyer')).endsAt;
  const replay = await verify('buyer', order.data.orderId, paymentId, sign(order.data.orderId, paymentId));
  check('Sending it again gives nothing extra', replay.data.outcome === 'already' && (await access('buyer')).endsAt === endsAt);

  const renewal = await call('POST', '/api/payments/order', tokens.buyer, { plan: 'monthly' });
  await verify('buyer', renewal.data.orderId, 'pay_fake2', sign(renewal.data.orderId, 'pay_fake2'));
  const days = (new Date((await access('buyer')).endsAt).getTime() - new Date(endsAt).getTime()) / 86400000;
  check('Renewing early adds a full 30 days', Math.round(days) === 30, `${days.toFixed(1)} days`);

  console.log('\nGateway trouble');
  gatewayDown = true;
  const down = await call('POST', '/api/payments/order', tokens.stranger, { plan: 'monthly' });
  gatewayDown = false;
  check('If Razorpay fails, the buyer gets a clear error and nothing is activated', down.status === 502 && (await access('stranger')).active === false, down.data?.error);

  console.log('\nWebhooks');
  const hookOrder = await call('POST', '/api/payments/order', tokens.hook, { plan: 'monthly' });
  const hookBody = (event: string, orderId: string, amount: number, payId = 'pay_hook1') =>
    JSON.stringify({ entity: 'event', event, contains: ['payment'], payload: { payment: { entity: { id: payId, order_id: orderId, amount, status: 'captured' } } } });
  const hook = async (body: string, signature: string | null, eventId?: string) => {
    const res = await fetch(`${BASE}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Razorpay-Signature': signature } : {}),
        ...(eventId ? { 'X-Razorpay-Event-Id': eventId } : {}),
      },
      body,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const captured = hookBody('payment.captured', hookOrder.data.orderId, 9900);
  check('No signature is refused', (await hook(captured, null)).status === 400);
  check('A wrong signature is refused', (await hook(captured, hmac(captured, 'wrong'))).status === 400);
  check('An altered body is refused', (await hook(captured.replace('9900', '100'), hmac(captured, WEBHOOK_SECRET))).status === 400);
  check('None of those activated anything', (await access('hook')).active === false);
  const wrongAmount = hookBody('payment.captured', hookOrder.data.orderId, 100);
  const mismatch = await hook(wrongAmount, hmac(wrongAmount, WEBHOOK_SECRET), 'evt_amount');
  check('A signed event with the wrong amount activates nothing', mismatch.data?.status === 'amount-mismatch' && (await access('hook')).active === false, mismatch.data?.status);
  const other = hookBody('payment.failed', hookOrder.data.orderId, 9900);
  check('Other events are ignored', (await hook(other, hmac(other, WEBHOOK_SECRET), 'evt_failed')).data?.status === 'ignored');
  const accepted = await hook(captured, hmac(captured, WEBHOOK_SECRET), 'evt_1');
  check('A valid webhook activates the plan', accepted.data?.status === 'settled' && (await access('hook')).plan === 'monthly', accepted.data?.status);
  const hookEnds = (await access('hook')).endsAt;
  const again = await hook(captured, hmac(captured, WEBHOOK_SECRET), 'evt_1');
  check('The same event twice is ignored', again.data?.status === 'duplicate', again.data?.status);
  const newId = await hook(captured, hmac(captured, WEBHOOK_SECRET), 'evt_2');
  check('A new event for a settled payment gives nothing extra', newId.data?.status === 'already' && (await access('hook')).endsAt === hookEnds, newId.data?.status);
  const afterHook = await verify('hook', hookOrder.data.orderId, 'pay_hook1', sign(hookOrder.data.orderId, 'pay_hook1'));
  check('The browser verifying afterwards gives nothing extra', afterHook.data?.outcome === 'already' && (await access('hook')).endsAt === hookEnds);

  console.log('\nCredits');
  const pack = await call('POST', '/api/payments/order', tokens.creditor, { plan: 'credits' });
  check('A credit pack costs its price', pack.data.amount === 4900);
  await verify('creditor', pack.data.orderId, 'pay_c1', sign(pack.data.orderId, 'pay_c1'));
  check('Buying gives credits', (await access('creditor')).credits === 2);
  check('A pre-fetch costs nothing', (await manifest('creditor', tracks[0].id, '?prefetch=1')).status === 200 && (await access('creditor')).credits === 2);
  await manifest('creditor', tracks[0].id);
  check('A play costs one', (await access('creditor')).credits === 1);
  await manifest('creditor', tracks[0].id);
  check('Reloading the same song costs nothing', (await access('creditor')).credits === 1);
  await manifest('creditor', tracks[1].id);
  check('Another song costs one more', (await access('creditor')).credits === 0);
  check('With none left, new songs are refused', (await manifest('creditor', tracks[2].id)).status === 402);
  check('The song just paid for still loads', (await manifest('creditor', tracks[1].id)).status === 200);
  const race = await call('POST', '/api/payments/order', tokens.racer, { plan: 'credits' });
  await verify('racer', race.data.orderId, 'pay_c2', sign(race.data.orderId, 'pay_c2'));
  const results = await Promise.all(tracks.map((t: any) => manifest('racer', t.id)));
  check('Requests at the same moment can\'t overspend', results.filter((r) => r.status === 200).length === 2 && (await access('racer')).credits === 0, results.map((r) => r.status).join());

  console.log('\nReceipts');
  const connect = (name: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(BASE, { auth: { token: tokens[name] }, transports: ['websocket'], reconnection: false });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  type Peer = { socket: Socket; session: string; held: { id: string; size: number }[] };
  const joinPeer = async (name: string): Promise<Peer> => {
    const socket = await connect(name);
    const reply: any = await new Promise((resolve) => socket.emit('peer:hello', { quotaMb: 100 }, resolve));
    const held: { id: string; size: number }[] = [];
    socket.on('peer:assign', ({ chunks }) => {
      if (!chunks.length) return;
      held.push(...chunks);
      socket.emit('peer:have', { chunkIds: chunks.map((c: any) => c.id) });
    });
    socket.emit('peer:have', { chunkIds: [] });
    return { socket, session: reply.peerSessionId, held };
  };
  const peerA = await joinPeer('con.a');
  const peerB = await joinPeer('con.b');
  await sleep(600);
  const mans = await Promise.all(tracks.map((t: any) => manifest('paid', t.id, '?prefetch=1')));
  const chunksOf = (i: number) => mans[i].data.chunks.filter((c: any) => c.idx > 0);
  check('Contributors hold the catalog', peerA.held.length === mans.reduce((s, m) => s + m.data.chunks.length, 0) && peerB.held.length === peerA.held.length, `${peerA.held.length}, ${peerB.held.length}`);
  const listen = async (name: string, trackIndex?: number) => {
    const socket = await connect(name);
    if (trackIndex !== undefined) socket.emit('play:request', { trackId: tracks[trackIndex].id, fromIdx: 0 });
    await sleep(100);
    return socket;
  };
  const receipt = (socket: Socket, chunkId: string, peerSessionId: string, extra = {}) =>
    new Promise<any>((resolve) => socket.emit('receipt:confirm', { chunkId, peerSessionId, ...extra }, resolve));

  const paidSocket = await listen('paid', 0);
  const c0 = chunksOf(0);
  const noRevenue = await receipt(paidSocket, c0[0].id, peerA.session);
  check('A valid receipt is accepted', noRevenue.accepted === true && noRevenue.payable === true, noRevenue.reason);
  check('The size comes from the catalog, not the claim', (await receipt(paidSocket, c0[1].id, peerA.session, { bytes: 999999999 })).bytes === c0[1].size);
  check('An unknown chunk is refused', (await receipt(paidSocket, crypto.randomUUID(), peerA.session)).reason === 'unknown-chunk');
  check('An unknown peer is refused', (await receipt(paidSocket, c0[0].id, crypto.randomUUID())).reason === 'unknown-peer');
  check('Malformed input is refused', (await receipt(paidSocket, 'nope', peerA.session)).reason === 'invalid');
  check('A repeated report is not paid twice', (await receipt(paidSocket, c0[0].id, peerA.session)).reason === 'duplicate');
  check("A song the listener isn't playing is refused", (await receipt(paidSocket, chunksOf(1)[0].id, peerA.session)).reason === 'not-playing-this-track');
  peerA.socket.emit('play:request', { trackId: tracks[0].id, fromIdx: 0 });
  await sleep(100);
  check('Nobody can pay themselves', (await receipt(peerA.socket, c0[2].id, peerA.session)).reason === 'same-user');
  const stranger = await listen('stranger', 0);
  check('An account with no plan earns nobody anything', (await receipt(stranger, c0[2].id, peerA.session)).reason === 'listener-has-no-plan');
  const late = await joinPeer('con.a');
  check('A peer that doesn\'t hold the chunk is refused', (await receipt(paidSocket, c0[3].id, late.session)).reason === 'peer-does-not-hold-it');
  late.socket.disconnect();
  await sleep(100);

  console.log('\nHourly caps');
  const capSocket = await listen('cap', 0);
  capSocket.emit('play:request', { trackId: tracks[1].id, fromIdx: 0 });
  capSocket.emit('play:request', { trackId: tracks[2].id, fromIdx: 0 });
  await sleep(100);
  const everything = [...chunksOf(0), ...chunksOf(1), ...chunksOf(2)];
  let pairCap = false;
  for (const c of everything) {
    const r = await receipt(capSocket, c.id, peerA.session);
    if (r.reason === 'pair-hourly-cap') {
      pairCap = true;
      break;
    }
  }
  check('The limit per contributor and listener pair applies', pairCap);
  let listenerCap = false;
  for (const c of everything) {
    const r = await receipt(capSocket, c.id, peerB.session);
    if (r.reason === 'listener-hourly-cap') {
      listenerCap = true;
      break;
    }
  }
  check('The limit per listener applies across contributors', listenerCap);

  console.log('\nPayouts');
  const stats = async (name: string) => (await call('GET', '/api/contributor/stats', tokens[name])).data;
  const history = async (name: string) => (await call('GET', '/api/contributor/earnings', tokens[name])).data.payouts;
  const payout = () => call('POST', '/api/admin/payout/run', tokens.admin, {});
  check('Non-admins cannot run a payout', (await call('POST', '/api/admin/payout/run', tokens.paid, {})).status === 403);
  check('Non-admins cannot see revenue', (await call('GET', '/api/admin/revenue', tokens.paid)).status === 403);
  const money0 = await revenue();
  const expectedGross = 9900 * 3 + 4900 * 2;
  check('Revenue is every payment, once', money0.grossPaise === expectedGross, money0.grossPaise);
  check('Fee is taken into account', money0.netPaise === money0.grossPaise - money0.feePaise && money0.feePaise > 0, money0.feePaise);

  const beforeA = await stats('con.a');
  const beforeB = await stats('con.b');
  const r1 = (await payout()).data;
  const afterA = await stats('con.a');
  const afterB = await stats('con.b');
  check('A payout runs', r1.ran === true, r1.paid);
  // Half of each net payment (REVENUE_CYCLES=2), then 60% of that.
  const money1 = await revenue();
  check('The pool is 60% of the revenue recognised', r1.pool === Math.floor((r1.revenue * 60) / 100), `${r1.pool} of ${r1.revenue}`);
  check('Revenue is spread across cycles, not spent at once', r1.revenue < money1.netPaise && money1.waitingPaise > 0, `${money1.waitingPaise} waiting`);
  const total = BigInt(beforeA.bytesUnsettled) + BigInt(beforeB.bytesUnsettled);
  const expectA = Number((BigInt(beforeA.bytesUnsettled) * BigInt(r1.pool)) / total);
  const expectB = Number((BigInt(beforeB.bytesUnsettled) * BigInt(r1.pool)) / total);
  check('Each share is exactly proportional to verified bytes', afterA.earnedPaise - beforeA.earnedPaise === expectA && afterB.earnedPaise - beforeB.earnedPaise === expectB, `${expectA}, ${expectB}`);
  check('Paid out plus leftover equals the pool', r1.paid + r1.carryOut === r1.pool, `${r1.paid} + ${r1.carryOut}`);
  check('Those deliveries are now settled', afterA.bytesUnsettled === 0 && afterB.bytesUnsettled === 0);
  check('The contributor\'s own history matches', (await history('con.a')).reduce((s: number, p: any) => s + p.paise, 0) === afterA.earnedPaise && (await history('con.a'))[0].bytes === beforeA.bytesUnsettled);
  const noDouble = (await payout()).data;
  check('Running it again pays nothing twice', noDouble.ran === false && (await stats('con.a')).earnedPaise === afterA.earnedPaise, noDouble.reason);

  check('Refused data was never counted', beforeA.bytesRefused > 0 && (await stats('con.a')).bytesTotal === beforeA.bytesTotal);
  const money1b = await revenue();
  check('The monitor lists each refusal reason', ['same-user', 'duplicate', 'listener-has-no-plan', 'pair-hourly-cap', 'listener-hourly-cap'].every((r) => money1b.refused.some((x: any) => x.reason === r)));

  const l2 = await listen('l2', 1);
  const l3 = await listen('l3', 2);
  await receipt(l2, chunksOf(1)[0].id, peerA.session);
  await receipt(l2, chunksOf(1)[1].id, peerB.session);
  await receipt(l3, chunksOf(2)[0].id, peerB.session);
  const r2 = (await payout()).data;
  check('A second cycle pays new deliveries', r2.ran === true && r2.paid > 0, r2.paid);
  await receipt(l2, chunksOf(1)[2].id, peerA.session);
  await payout();
  const money2 = await revenue();
  check('Once spread, all revenue has been recognised', money2.waitingPaise === 0, money2.waitingPaise);
  await sleep(50);

  console.log('\nEvery paisa accounted for');
  check('Paid by listeners = fee + net', money2.grossPaise === money2.feePaise + money2.netPaise);
  check('Net = contributors\' share + platform\'s share', money2.netPaise === money2.contributorSharePaise + money2.platformPaise, `${money2.netPaise} = ${money2.contributorSharePaise} + ${money2.platformPaise}`);
  check('Contributors\' share = paid out + leftover', money2.contributorSharePaise === money2.paidPaise + money2.carryPaise, `${money2.contributorSharePaise} = ${money2.paidPaise} + ${money2.carryPaise}`);
  const ledgerA = (await stats('con.a')).earnedPaise;
  const ledgerB = (await stats('con.b')).earnedPaise;
  check('Contributors\' balances = total paid out', ledgerA + ledgerB === money2.paidPaise, `${ledgerA} + ${ledgerB} = ${money2.paidPaise}`);
  check('The platform kept about 40% of net', Math.abs(money2.platformPaise / money2.netPaise - 0.4) < 0.001, (money2.platformPaise / money2.netPaise).toFixed(4));

  console.log('\nRate limit');
  const flood = await listen('paid', 0);
  const replies = await Promise.all(Array.from({ length: 70 }, () => receipt(flood, c0[0].id, peerA.session)));
  check('Excess receipts are refused', replies.filter((r) => r.reason === 'rate-limited').length === 10, replies.filter((r) => r.reason === 'rate-limited').length);

  for (const s of [paidSocket, stranger, capSocket, l2, l3, flood, peerA.socket, peerB.socket]) s.disconnect();

  console.log('\nThe same-network rule, turned on');
  await stopServer();
  await startServer({ REJECT_SHARED_IP: 'true' });
  const [pa, ls] = [await joinPeer('con.a'), await listen('l2', 0)];
  await sleep(400);
  const shared = await receipt(ls, c0[0].id, pa.session);
  check('Someone on the same address as the listener is refused', shared.reason === 'shared-ip', shared.reason);
  check('Settings show it on', (await call('GET', '/api/admin/revenue', tokens.admin)).data.rules.rejectSharedIp === true);
  pa.socket.disconnect();
  ls.disconnect();
  await stopServer();

  console.log('\nThe payment flow in real Chrome (Razorpay\'s window is replaced by a stand-in)');
  await startServer({ RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(CHROME)) {
    console.log('  SKIP  Chrome is not installed');
  } else {
    const puppeteer = (await import('puppeteer-core')).default;
    const profile = fs.mkdtempSync(path.join(work, 'chrome-'));
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-audio-output'], defaultViewport: { width: 1280, height: 850 } });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push((e as Error).message));
    await page.exposeFunction('testSign', (orderId: string, payId: string) => sign(orderId, payId));
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith('https://checkout.razorpay.com/v1/checkout.js')) {
        req.respond({
          contentType: 'application/javascript',
          body: `window.Razorpay = function (o) {
            window.__checkoutOptions = o;
            this.on = function () {};
            this.open = async function () {
              o.handler({ razorpay_order_id: o.order_id, razorpay_payment_id: 'pay_chrome1', razorpay_signature: await window.testSign(o.order_id, 'pay_chrome1') });
            };
          };`,
        });
      } else {
        req.continue();
      }
    });
    await page.goto(`${BASE}/?as=new.listener&go=%2F`, { waitUntil: 'networkidle2' });
    // A listener with no plan is sent to Plan before any music page.
    await page.waitForSelector('[data-testid="plan-status"]', { timeout: 10000 });
    check('A listener with no plan opens on the Plan page', page.url().endsWith('/subscribe'), page.url());
    check('It says there is no plan yet', (await page.$eval('[data-testid="plan-status"]', (e) => e.textContent ?? '')).includes('don\u2019t have a plan'));
    check('It offers test card details', (await page.evaluate(() => document.body.innerText)).includes('4100 2800 0000 1007'));
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Buy monthly')) as HTMLElement).click());
    await page.waitForSelector('[data-testid="plan-success"]', { timeout: 5000 });
    const opts: any = await page.evaluate(() => (window as any).__checkoutOptions);
    check('Checkout gets every option Razorpay requires', Boolean(opts.key === KEY_ID && opts.amount === 9900 && opts.currency === 'INR' && opts.name && opts.order_id), JSON.stringify({ amount: opts.amount, key: opts.key }));
    check('The Plan page shows it active', (await page.$eval('[data-testid="plan-status"]', (e) => e.textContent ?? '')).startsWith('Monthly plan'));
    await page.evaluate(() => (document.querySelector('a[href="/"]') as HTMLElement).click());
    await page.waitForSelector('main li button');
    await page.evaluate(() => (document.querySelector('main li button') as HTMLElement).click());
    await sleep(2500);
    const playing = await page.evaluate(() => ({ error: document.querySelector('[data-testid="player-error"]')?.textContent ?? '', notice: document.querySelector('[data-testid="peer-notice"]')?.textContent ?? '' }));
    check('After paying, the paywall is gone', playing.error === '', playing.error);
    check('...and only contributors stand between them and the music', playing.notice.includes('No contributors'), playing.notice);
    check('No script errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();

    // The genuine script, under the site's real security policy. It needs internet.
    const real = await browser.newPage();
    const blocked_: string[] = [];
    real.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) blocked_.push(m.text());
    });
    await real.goto(`${BASE}/lab`, { waitUntil: 'networkidle2' });
    const loaded = await real.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const s = document.createElement('script');
          s.src = 'https://checkout.razorpay.com/v1/checkout.js';
          s.onload = () => resolve(typeof (window as any).Razorpay);
          s.onerror = () => resolve('failed');
          document.head.appendChild(s);
        }),
    );
    check("Razorpay's real script loads under our security policy", loaded === 'function' && blocked_.length === 0, loaded === 'failed' ? 'could not load: offline or blocked' : blocked_[0] ?? loaded);
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  finish(failed ? 1 : 0);
} catch (err) {
  console.error('The test crashed:', err);
  finish(2);
}
