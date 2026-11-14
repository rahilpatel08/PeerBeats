import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { recordReceipt } from '../ledger/index.js';

// Every contributor up to five holds a copy, so each one can deliver.
const REPLICATION_TARGET = 5;
const ASSIGN_BATCH = 40;
const ASSIGN_CANDIDATES = 400;
const ASSIGN_TIMEOUT_MS = 60000;
const HEARTBEAT_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const REBALANCE_MS = 10000;
const QUARANTINE_MISMATCHES = 5;
const QUARANTINE_REPORTERS = 2;
const FAILURE_REPORTS_PER_MINUTE = 6;
const RECEIPTS_PER_WINDOW = 60;
const RECEIPT_WINDOW_MS = 30000;
const TRANSFER_WINDOW_MS = 4000;
const FEED_SIZE = 25;
// A relayed piece is 16 KB. Anything much larger isn't one.
const RELAY_PIECE_LIMIT = 64 * 1024;
const RELAY_TEXT_LIMIT = 4096;
const EVENT_LOG_SIZE = 30;

const uuid = z.string().uuid();
const helloBody = z.object({ quotaMb: z.number().int().min(1).max(4096) });
const haveBody = z.object({ chunkIds: z.array(uuid).max(20000) });
const playBody = z.object({
  trackId: uuid,
  fromIdx: z.number().int().min(0).default(0),
  // Looking up the next queued track must not mark this listener as playing it.
  lookupOnly: z.boolean().default(false),
});
const listenerState = z.object({ state: z.enum(['playing', 'waiting', 'paused']) });
const signalBody = z.object({ to: z.string().min(1).max(64), sdp: z.string().min(1).max(30000) });
const iceBody = z.object({
  to: z.string().min(1).max(64),
  kind: z.enum(['listener', 'contributor']),
  candidate: z.object({}).passthrough(),
});
const relayTo = z.object({ to: z.string().min(1).max(64), kind: z.enum(['listener', 'contributor']).default('listener') });
const receiptBody = z.object({
  chunkId: uuid,
  peerSessionId: uuid,
  latencyMs: z.number().min(0).max(120000).optional(),
});
const failureStat = z.object({
  peerSessionId: uuid,
  reason: z.enum(['timeout', 'miss', 'hash-mismatch', 'peer-left']),
});

interface LiveSession {
  sessionId: string;
  socketId: string;
  userId: string;
  name: string;
  quotaMb: number;
  connectedAt: number;
  servedBytes: number;
  servedChunks: number;
  assigned: Set<string>;
  /** Told to store these, not yet reported back. Each counts toward replication until it expires. */
  outstanding: Map<string, number>;
  /** Has reported what it already holds, so it is safe to assign more. */
  ready: boolean;
  full: boolean;
  lastSeen: number;
  /** Recent success rate from 0 to 1, and recent latency. These decide who is offered first. */
  success: number;
  latencyMs: number | null;
  mismatches: number;
  mismatchReporters: Set<string>;
  ip: string;
}

/** Higher is better: reliable first, then fast. */
const scoreOf = (s: LiveSession) => s.success / (1 + (s.latencyMs ?? 50) / 200);

type ListenerState = 'playing' | 'waiting' | 'paused';

interface LiveListener {
  socketId: string;
  userId: string;
  name: string;
  trackId: string | null;
  trackTitle: string | null;
  state: ListenerState;
}

interface Transfer {
  from: string; // a peer session id
  to: string; // a listener socket id
  at: number;
}

interface FeedItem {
  at: number;
  listener: string;
  from: string;
  trackTitle: string | null;
  idx: number;
  bytes: number;
}

export interface Tracker {
  snapshot: () => Promise<unknown>;
  /** Forgets delivery figures held in memory, after the ledger has been cleared. */
  resetTotals: () => void;
  labSummary: () => Promise<unknown>;
  /** Only contributors may download from the server, and only what they were told to store. */
  canSeed: (userId: string, chunkId: string) => Promise<boolean>;
  noteSeeded: (bytes: number) => void;
  /** New music arrived, so give it to contributors now rather than at the next sweep. */
  rebalance: () => Promise<void>;
}

export function createTracker(httpServer: HttpServer, db: Db): Tracker {
  // A closed tab is noticed at once. A vanished phone is noticed within 45 seconds.
  const io = new Server(httpServer, { pingInterval: 15000, pingTimeout: 30000, maxHttpBufferSize: 2_000_000 });
  const sessions = new Map<string, LiveSession>();
  const listeners = new Map<string, LiveListener>();
  let transfers: Transfer[] = [];
  // Verified bytes from each contributor to each listener, keyed "session>socket".
  const pairBytes = new Map<string, number>();
  const feed: FeedItem[] = [];
  const totals = { peerBytes: 0, peerChunks: 0, seededBytes: 0, relayedBytes: 0 };
  // Listener socket id -> the contributor sessions it reaches through the relay.
  const relays = new Map<string, Set<string>>();
  const events: { at: number; kind: 'join' | 'leave' | 'problem' | 'repair'; text: string }[] = [];
  let rebuildPending = false;

  function logEvent(kind: (typeof events)[number]['kind'], text: string) {
    events.unshift({ at: Date.now(), kind, text });
    events.length = Math.min(events.length, EVENT_LOG_SIZE);
  }

  // Sessions from before a restart can never be reached again.
  db.exec('delete from peer_sessions').catch((err) => console.error(err));

  io.use((socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
      socket.data.userId = payload.sub;
      // Through the phone link every connection arrives from this machine, so ask the tunnel.
      const address = socket.handshake.address;
      const viaLocalProxy = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
      const forwarded = socket.handshake.headers['cf-connecting-ip'];
      socket.data.ip = viaLocalProxy && typeof forwarded === 'string' ? forwarded : address;
      socket.data.tracks = new Set<string>();
      socket.data.receiptTimes = [] as number[];
      next();
    } catch {
      next(new Error('Please log in.'));
    }
  });

  const sessionOf = (socket: Socket) => (socket.data.sessionId ? sessions.get(socket.data.sessionId) : undefined);

  /** Removes a peer from the network, then finds new homes for the copies it took with it. */
  async function endSession(session: LiveSession, why: string, kind: 'leave' | 'problem' = 'leave') {
    if (!sessions.delete(session.sessionId)) return;
    for (const [listenerSocketId, reached] of relays) {
      if (reached.delete(session.sessionId)) io.to(listenerSocketId).emit('relay:close', { from: session.sessionId });
    }
    const socket = io.sockets.sockets.get(session.socketId);
    if (socket) socket.data.sessionId = undefined;
    await db.query('delete from peer_sessions where id = $1', [session.sessionId]);
    logEvent(kind, `${session.name} ${why}`);
    rebuildPending = true;
    await rebalance();
  }

  /** Tells a contributor what to store next: the least-replicated, most-played chunks first. */
  async function assignMore(session: LiveSession, alwaysReply: boolean) {
    const { rows: held } = await db.query<{ total: string }>(
      `select coalesce(sum(c.size_bytes), 0) as total from peer_chunks pc
       join chunks c on c.id = pc.chunk_id where pc.peer_session_id = $1`,
      [session.sessionId],
    );
    let free = session.quotaMb * 1024 * 1024 - Number(held[0].total);
    const { rows } = await db.query<{ id: string; sha256: string; size_bytes: number; n: string }>(
      `select c.id, c.sha256, c.size_bytes, coalesce(r.n, 0) as n
       from chunks c
       join tracks t on t.id = c.track_id
       left join (select chunk_id, count(*) as n from peer_chunks group by chunk_id) r on r.chunk_id = c.id
       where coalesce(r.n, 0) < $2
         and not exists (select 1 from peer_chunks pc where pc.chunk_id = c.id and pc.peer_session_id = $1)
       order by coalesce(r.n, 0), t.play_count desc, c.track_id, c.idx
       limit $3`,
      [session.sessionId, REPLICATION_TARGET, ASSIGN_CANDIDATES],
    );
    // Copies already on their way count too, or several contributors would all fetch the same ones.
    const onTheWay = new Map<string, number>();
    for (const other of sessions.values()) {
      for (const id of other.outstanding.keys()) onTheWay.set(id, (onTheWay.get(id) ?? 0) + 1);
    }
    const chunks = [];
    const expires = Date.now() + ASSIGN_TIMEOUT_MS;
    for (const row of rows) {
      if (chunks.length >= ASSIGN_BATCH) break;
      if (Number(row.n) + (onTheWay.get(row.id) ?? 0) >= REPLICATION_TARGET) continue;
      if (row.size_bytes > free) break;
      free -= row.size_bytes;
      session.assigned.add(row.id);
      session.outstanding.set(row.id, expires);
      chunks.push({ id: row.id, sha256: row.sha256, size: row.size_bytes });
    }
    if (chunks.length && rebuildPending) {
      rebuildPending = false;
      logEvent('repair', `Rebuilding lost copies on ${session.name}`);
    }
    // Hashes only. Contributors are never sent a decryption key.
    if (chunks.length || alwaysReply) io.to(session.socketId).emit('peer:assign', { chunks });
  }

  let rebalancing = false;
  /** Gives idle contributors any work that exists: a peer left, or new space appeared. */
  async function rebalance() {
    if (rebalancing) return;
    rebalancing = true;
    try {
      const now = Date.now();
      for (const session of sessions.values()) {
        for (const [id, expires] of session.outstanding) {
          if (expires <= now) session.outstanding.delete(id);
        }
        if (session.ready && !session.full && session.outstanding.size === 0) await assignMore(session, false);
      }
    } finally {
      rebalancing = false;
    }
  }

  const rebalanceTimer = setInterval(() => {
    rebalance().catch((err) => console.error('[tracker] rebalance:', err));
  }, REBALANCE_MS);
  rebalanceTimer.unref();

  // The server asks and contributors answer. This also survives hidden tabs, where browsers
  // slow down a contributor's own timers but still deliver messages straight away.
  const heartbeatTimer = setInterval(async () => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        io.to(session.socketId).emit('peer:removed', { reason: 'no heartbeat' });
        await endSession(session, 'stopped responding and was removed', 'problem').catch((err) => console.error(err));
      } else {
        io.to(session.socketId).emit('peer:ping');
      }
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();

  async function sendPeers(socket: Socket, trackId: string) {
    const { rows } = await db.query<{ idx: number; peer: string }>(
      `select c.idx, pc.peer_session_id as peer
       from peer_chunks pc
       join chunks c on c.id = pc.chunk_id
       join peer_sessions ps on ps.id = pc.peer_session_id
       where c.track_id = $1 and ps.user_id <> $2
       order by c.idx`,
      [trackId, socket.data.userId],
    );
    const peers: Record<number, string[]> = {};
    const names: Record<string, string> = {};
    for (const row of rows) {
      const session = sessions.get(row.peer);
      if (!session) continue;
      (peers[row.idx] ??= []).push(row.peer);
      names[row.peer] = session.name;
    }
    const rank = (id: string) => {
      const session = sessions.get(id);
      return session ? scoreOf(session) : 0;
    };
    for (const ids of Object.values(peers)) ids.sort((a, b) => rank(b) - rank(a));
    socket.emit('play:peers', { trackId, peers, names });
  }

  /** Runs a handler and logs bad input, so one malformed message cannot take the server down. */
  const on = (socket: Socket, event: string, handler: (data: any) => Promise<void> | void) => {
    socket.on(event, async (data) => {
      try {
        await handler(data);
      } catch (err) {
        if (!(err instanceof z.ZodError)) console.error(`[tracker] ${event}:`, err);
        socket.emit('tracker:error', { event, message: err instanceof z.ZodError ? 'Invalid message.' : 'Server error.' });
      }
    });
  };

  io.on('connection', async (socket) => {
    const { rows } = await db.query<{ display_name: string; is_contributor: boolean; is_admin: boolean }>(
      'select display_name, is_contributor, is_admin from users where id = $1',
      [socket.data.userId],
    );
    if (!rows[0]) {
      socket.disconnect(true);
      return;
    }
    const name = rows[0].display_name;
    const isAdmin = rows[0].is_admin;

    socket.on('peer:hello', async (data, ack) => {
      try {
        const { quotaMb } = helloBody.parse(data);
        const { rows: user } = await db.query<{ is_contributor: boolean }>('select is_contributor from users where id = $1', [socket.data.userId]);
        if (!user[0]?.is_contributor) return ack?.({ error: 'Turn on sharing for this account first.' });
        const previous = sessionOf(socket);
        if (previous) await endSession(previous, 'reconnected');
        const { rows: created } = await db.query<{ id: string }>(
          'insert into peer_sessions (user_id, socket_id, storage_quota_mb) values ($1, $2, $3) returning id',
          [socket.data.userId, socket.id, quotaMb],
        );
        const session: LiveSession = {
          sessionId: created[0].id,
          socketId: socket.id,
          userId: socket.data.userId,
          name,
          quotaMb,
          connectedAt: Date.now(),
          servedBytes: 0,
          servedChunks: 0,
          assigned: new Set(),
          outstanding: new Map(),
          ready: false,
          full: false,
          lastSeen: Date.now(),
          success: 1,
          latencyMs: null,
          mismatches: 0,
          mismatchReporters: new Set(),
          ip: socket.data.ip,
        };
        sessions.set(session.sessionId, session);
        socket.data.sessionId = session.sessionId;
        logEvent('join', `${name} joined`);
        ack?.({ peerSessionId: session.sessionId });
      } catch (err) {
        if (!(err instanceof z.ZodError)) console.error('[tracker] peer:hello:', err);
        ack?.({ error: 'Could not start sharing.' });
      }
    });

    on(socket, 'peer:have', async (data) => {
      const session = sessionOf(socket);
      if (!session) return;
      const { chunkIds } = haveBody.parse(data);
      if (chunkIds.length) {
        // Joining on chunks ignores any id that is not really in the catalog.
        await db.query(
          `insert into peer_chunks (peer_session_id, chunk_id)
           select $1, c.id from chunks c where c.id = any($2::uuid[])
           on conflict do nothing`,
          [session.sessionId, chunkIds],
        );
      }
      await db.query('update peer_sessions set last_seen = now() where id = $1', [session.sessionId]);
      session.lastSeen = Date.now();
      session.ready = true;
      for (const id of chunkIds) session.outstanding.delete(id);
      if (session.outstanding.size === 0) await assignMore(session, true);
    });

    on(socket, 'peer:heartbeat', async () => {
      const session = sessionOf(socket);
      if (!session) return;
      session.lastSeen = Date.now();
      await db.query('update peer_sessions set last_seen = now() where id = $1', [session.sessionId]);
    });

    on(socket, 'peer:full', () => {
      const session = sessionOf(socket);
      if (session) {
        session.full = true;
        session.outstanding.clear();
      }
    });

    on(socket, 'peer:bye', async () => {
      const session = sessionOf(socket);
      if (session) await endSession(session, 'stopped sharing');
    });

    on(socket, 'play:request', async (data) => {
      const { trackId, lookupOnly } = playBody.parse(data);
      socket.data.tracks.add(trackId);
      if (!lookupOnly) {
        const { rows: track } = await db.query<{ title: string }>('select title from tracks where id = $1', [trackId]);
        const existing = listeners.get(socket.id);
        const sameTrack = existing?.trackId === trackId;
        listeners.set(socket.id, {
          socketId: socket.id,
          userId: socket.data.userId,
          name,
          trackId,
          trackTitle: track[0]?.title ?? null,
          state: sameTrack ? existing.state : 'waiting',
        });
      }
      await sendPeers(socket, trackId);
    });

    on(socket, 'play:status', (data) => {
      const { state } = listenerState.parse(data);
      const listener = listeners.get(socket.id);
      if (listener) listener.state = state;
    });

    on(socket, 'play:stop', () => {
      listeners.delete(socket.id);
    });

    // Signaling: the tracker only passes these along so that two browsers can connect directly.
    on(socket, 'signal:offer', (data) => {
      const { to, sdp } = signalBody.parse(data);
      const target = sessions.get(to);
      if (target) io.to(target.socketId).emit('signal:offer', { from: socket.id, sdp });
    });
    on(socket, 'signal:answer', (data) => {
      const { to, sdp } = signalBody.parse(data);
      const session = sessionOf(socket);
      if (session) io.to(to).emit('signal:answer', { from: session.sessionId, sdp });
    });
    on(socket, 'signal:ice', (data) => {
      const { to, kind, candidate } = iceBody.parse(data);
      if (kind === 'listener') {
        const target = sessions.get(to);
        if (target) io.to(target.socketId).emit('signal:ice', { from: socket.id, kind, candidate });
      } else {
        const session = sessionOf(socket);
        if (session) io.to(to).emit('signal:ice', { from: session.sessionId, kind, candidate });
      }
    });

    // The relay. Two phones that can't reach each other directly (most mobile networks don't allow
    // it) pass their messages through here instead. The pieces are the same encrypted ones, still
    // sent by the contributor's phone and still checked by the listener. The server only forwards.
    on(socket, 'relay:open', (data) => {
      const { to } = relayTo.parse(data);
      const target = sessions.get(to);
      if (!target) {
        socket.emit('relay:close', { from: to });
        return;
      }
      if (!relays.has(socket.id)) relays.set(socket.id, new Set());
      relays.get(socket.id)!.add(to);
      io.to(target.socketId).emit('relay:open', { from: socket.id });
    });
    on(socket, 'relay:accept', (data) => {
      const { to } = relayTo.parse(data);
      const session = sessionOf(socket);
      if (session && relays.get(to)?.has(session.sessionId)) io.to(to).emit('relay:accept', { from: session.sessionId });
    });
    on(socket, 'relay:close', (data) => {
      const { to, kind } = relayTo.parse(data);
      if (kind === 'listener') {
        const target = sessions.get(to);
        if (relays.get(socket.id)?.delete(to) && target) io.to(target.socketId).emit('relay:close', { from: socket.id });
      } else {
        const session = sessionOf(socket);
        if (session && relays.get(to)?.delete(session.sessionId)) io.to(to).emit('relay:close', { from: session.sessionId });
      }
    });
    // Not through `on`: forwarding must stay in the order the messages arrived.
    socket.on('relay:data', (message, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { to, kind, data } = (message ?? {}) as { to?: unknown; kind?: unknown; data?: unknown };
      const isText = typeof data === 'string' && data.length <= RELAY_TEXT_LIMIT;
      const isPiece = Buffer.isBuffer(data) && data.length <= RELAY_PIECE_LIMIT;
      if (typeof to !== 'string' || (!isText && !isPiece)) return reply(false);
      if (kind === 'listener') {
        const target = sessions.get(to);
        if (!target || !relays.get(socket.id)?.has(to)) return reply(false);
        io.to(target.socketId).emit('relay:data', { from: socket.id, data });
      } else {
        const session = sessionOf(socket);
        if (!session || !relays.get(to)?.has(session.sessionId)) return reply(false);
        io.to(to).emit('relay:data', { from: session.sessionId, data });
        if (isPiece) totals.relayedBytes += (data as Buffer).length;
      }
      reply(true);
    });

    // Sent only after a segment's hash matched. This is what contributors get paid for.
    socket.on('receipt:confirm', async (data, ack) => {
      try {
        const body = receiptBody.parse(data);
        const now = Date.now();
        socket.data.receiptTimes = socket.data.receiptTimes.filter((t: number) => now - t < RECEIPT_WINDOW_MS);
        if (socket.data.receiptTimes.length >= RECEIPTS_PER_WINDOW) {
          ack?.({ accepted: false, reason: 'rate-limited' });
          return;
        }
        socket.data.receiptTimes.push(now);
        const session = sessions.get(body.peerSessionId);
        if (!session) {
          ack?.({ accepted: false, reason: 'unknown-peer' });
          return;
        }
        const result = await recordReceipt(db, {
          chunkId: body.chunkId,
          contributorId: session.userId,
          peerSessionId: session.sessionId,
          listenerId: socket.data.userId,
          listenerSocketId: socket.id,
          listenerTracks: socket.data.tracks,
          sameIp: session.ip === socket.data.ip,
        });
        ack?.(result);
        if (!result.accepted) return;

        session.success = session.success * 0.8 + 0.2;
        if (body.latencyMs !== undefined) {
          session.latencyMs = session.latencyMs === null ? body.latencyMs : session.latencyMs * 0.8 + body.latencyMs * 0.2;
        }
        totals.peerBytes += result.bytes!;
        totals.peerChunks++;
        session.servedBytes += result.bytes!;
        session.servedChunks++;
        const pair = `${session.sessionId}>${socket.id}`;
        pairBytes.set(pair, (pairBytes.get(pair) ?? 0) + result.bytes!);
        transfers.push({ from: session.sessionId, to: socket.id, at: now });
        feed.unshift({
          at: now,
          listener: name,
          from: session.name,
          trackTitle: listeners.get(socket.id)?.trackTitle ?? null,
          idx: result.idx!,
          bytes: result.bytes!,
        });
        feed.length = Math.min(feed.length, FEED_SIZE);
      } catch (err) {
        if (!(err instanceof z.ZodError)) console.error('[tracker] receipt:confirm:', err);
        ack?.({ accepted: false, reason: 'invalid' });
      }
    });

    on(socket, 'stats:failure', async (data) => {
      const { peerSessionId, reason } = failureStat.parse(data);
      const session = sessions.get(peerSessionId);
      if (!session || session.userId === socket.data.userId || reason === 'peer-left') return;
      // One listener can only do so much harm to a contributor's standing.
      const key = `failures:${peerSessionId}`;
      const now = Date.now();
      const recent = ((socket.data[key] ?? []) as number[]).filter((t) => now - t < 60000);
      if (recent.length >= FAILURE_REPORTS_PER_MINUTE) return;
      socket.data[key] = [...recent, now];
      session.success *= 0.8;
      if (reason !== 'hash-mismatch') return;
      session.mismatches++;
      session.mismatchReporters.add(socket.data.userId);
      logEvent('problem', `${name} caught a damaged copy from ${session.name}`);
      // It takes two different listeners, or one dishonest listener could remove anyone.
      if (session.mismatches >= QUARANTINE_MISMATCHES && session.mismatchReporters.size >= QUARANTINE_REPORTERS) {
        // It must check everything it holds and rejoin, advertising only what still verifies.
        io.to(session.socketId).emit('peer:removed', { reason: 'too many damaged copies' });
        await endSession(session, 'served too many damaged copies and was removed', 'problem');
      }
    });

    on(socket, 'admin:watch', async () => {
      if (!isAdmin) return;
      socket.join('admins');
      socket.emit('admin:network', await snapshot());
    });
    on(socket, 'admin:unwatch', () => {
      socket.leave('admins');
    });

    socket.on('disconnect', () => {
      listeners.delete(socket.id);
      for (const sessionId of relays.get(socket.id) ?? []) {
        const target = sessions.get(sessionId);
        if (target) io.to(target.socketId).emit('relay:close', { from: socket.id });
      }
      relays.delete(socket.id);
      const session = sessionOf(socket);
      if (session) endSession(session, 'disconnected').catch((err) => console.error(err));
    });
  });

  async function snapshot() {
    const { rows: held } = await db.query<{ peer_session_id: string; chunks: string; bytes: string }>(
      `select pc.peer_session_id, count(*) as chunks, sum(c.size_bytes) as bytes
       from peer_chunks pc join chunks c on c.id = pc.chunk_id group by pc.peer_session_id`,
    );
    const heldBy = new Map(held.map((h) => [h.peer_session_id, h]));
    const { rows: coverage } = await db.query<{ id: string; title: string; genre: string | null; min_replicas: string; plays: number }>(
      `select t.id, t.title, t.genre, t.play_count as plays, min(coalesce(r.n, 0)) as min_replicas
       from tracks t
       join chunks c on c.track_id = t.id
       left join (select chunk_id, count(*) as n from peer_chunks group by chunk_id) r on r.chunk_id = c.id
       group by t.id, t.title, t.genre, t.play_count
       order by t.play_count desc, t.title`,
    );
    const now = Date.now();
    transfers = transfers.filter((t) => now - t.at < TRANSFER_WINDOW_MS);
    for (const key of pairBytes.keys()) {
      const [from, to] = key.split('>');
      if (!sessions.has(from) || !listeners.has(to)) pairBytes.delete(key);
    }
    const liveTransfers = [...new Map(transfers.map((t) => [`${t.from}>${t.to}`, { from: t.from, to: t.to }])).values()];
    return {
      at: now,
      replicationTarget: REPLICATION_TARGET,
      peers: [...sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        name: s.name,
        quotaMb: s.quotaMb,
        connectedAt: s.connectedAt,
        chunks: Number(heldBy.get(s.sessionId)?.chunks ?? 0),
        bytes: Number(heldBy.get(s.sessionId)?.bytes ?? 0),
        servedBytes: s.servedBytes,
        servedChunks: s.servedChunks,
        successPct: Math.round(s.success * 100),
        latencyMs: s.latencyMs === null ? null : Math.round(s.latencyMs),
        score: Math.round(scoreOf(s) * 100),
        lastSeenAgoMs: now - s.lastSeen,
      })),
      listeners: [...listeners.values()].map((l) => ({ socketId: l.socketId, name: l.name, trackTitle: l.trackTitle, state: l.state })),
      tracks: coverage.map((t) => {
        const minReplicas = Number(t.min_replicas);
        return {
          id: t.id,
          title: t.title,
          genre: t.genre,
          minReplicas,
          health: minReplicas >= REPLICATION_TARGET ? 'green' : minReplicas >= 1 ? 'amber' : 'red',
        };
      }),
      totals,
      transfers: liveTransfers,
      deliveries: [...pairBytes].map(([key, bytes]) => {
        const [from, to] = key.split('>');
        return { from, to, bytes };
      }),
      feed,
      events,
    };
  }

  const timer = setInterval(async () => {
    if ((io.sockets.adapter.rooms.get('admins')?.size ?? 0) === 0) return;
    try {
      io.to('admins').emit('admin:network', await snapshot());
    } catch (err) {
      console.error('[tracker] snapshot:', err);
    }
  }, 1000);
  timer.unref();

  async function labSummary() {
    const { rows } = await db.query<{ peer_session_id: string; chunks: string }>(
      'select peer_session_id, count(*) as chunks from peer_chunks group by peer_session_id',
    );
    const counts = new Map(rows.map((r) => [r.peer_session_id, Number(r.chunks)]));
    const { rows: total } = await db.query<{ n: string }>('select count(*) as n from chunks');
    return {
      totalChunks: Number(total[0].n),
      peers: [...sessions.values()].map((s) => ({ name: s.name, chunks: counts.get(s.sessionId) ?? 0 })),
      listeners: [...listeners.values()].map((l) => ({ name: l.name, trackTitle: l.trackTitle, state: l.state })),
    };
  }

  async function canSeed(userId: string, chunkId: string) {
    const own = [...sessions.values()].filter((session) => session.userId === userId);
    if (!own.length) return false;
    if (own.some((session) => session.assigned.has(chunkId))) return true;
    // A contributor also repairs a copy it already holds, which an earlier session assigned.
    const { rows } = await db.query(
      `select 1 from peer_chunks pc join peer_sessions ps on ps.id = pc.peer_session_id
       where pc.chunk_id = $1 and ps.user_id = $2 limit 1`,
      [chunkId, userId],
    );
    return rows.length > 0;
  }

  function resetTotals() {
    totals.peerBytes = 0;
    totals.peerChunks = 0;
    totals.seededBytes = 0;
    totals.relayedBytes = 0;
    pairBytes.clear();
    feed.length = 0;
    for (const session of sessions.values()) {
      session.servedBytes = 0;
      session.servedChunks = 0;
    }
    logEvent('repair', 'Delivery and payout records cleared');
  }

  return {
    snapshot,
    resetTotals,
    labSummary,
    rebalance,
    canSeed,
    noteSeeded: (bytes) => {
      totals.seededBytes += bytes;
    },
  };
}
