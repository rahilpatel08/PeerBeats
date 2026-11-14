import type { Socket } from 'socket.io-client';
import { getRtcConfig } from './rtcConfig';
import { getSocket } from './socket';
import { DirectWire, RelayWire, type Payload, type Wire } from './wire';

// A request has failed when its peer sends nothing for this long. Not a limit on the whole
// segment: a slow phone that keeps sending is still delivering.
const STALL_MS = 2500;
const RELAY_STALL_MS = 4000;
const CHUNK_LIMIT_MS = 20000;
const CONNECT_TIMEOUT_MS = 8000;
// How long a direct connection gets before the relay is asked as well. Whichever opens first
// is used, and a direct connection that opens later takes over.
const RELAY_AFTER_MS = 1200;
const RETRY_AFTER_MS = 5000;
const PING_MS = 1500;
const SILENCE_LIMIT_MS = 4000;
const RELAY_SILENCE_LIMIT_MS = 7000;
const REFRESH_MS = 3000;
const MAX_LINKS = 5;
const BAD_COPY_RETRY_MS = 3000;
const SPREAD_GRACE_MS = 300;

export type FailureReason = 'timeout' | 'miss' | 'peer-left';

export class PeerFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

export interface PeerSource {
  peerId: string;
  name: string;
  /** How this contributor's segments reach this listener right now. */
  via: () => 'direct' | 'relay';
  fetch: (chunkId: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  reportBad: (chunkId: string) => void;
  reportFailure: (reason: FailureReason) => void;
}

interface Pending {
  resolve: (bytes: ArrayBuffer) => void;
  reject: (err: Error) => void;
}

/** Direct connections that never opened, in a row. After a few, the relay is asked straight away. */
let directFailures = 0;

/**
 * This listener's connection to one contributor. It tries a direct WebRTC channel, and asks the
 * tracker to relay if that hasn't opened in time, as on most mobile networks. Requests go over
 * whichever path is in use, and the contributor answers on the same one.
 */
class PeerLink {
  private pc: RTCPeerConnection;
  private direct: DirectWire;
  private relay: RelayWire | null = null;
  /** The path requests are sent on. Null until one opens. */
  private wire: Wire | null = null;
  inflight = 0;
  /** Recent results from this listener's own view of this peer. */
  success = 1;
  latencyMs = 50;
  private closed = false;
  private directOver = false;
  private lastHeard = Date.now();
  /** When this peer last sent part of a segment. */
  private lastProgress = 0;
  private pingTimer: number | undefined;
  private relayTimer: number | undefined;
  private pending = new Map<string, Pending>();
  private incoming: { id: string; size: number; parts: ArrayBuffer[]; received: number } | null = null;
  private iceQueue: RTCIceCandidateInit[] = [];

  constructor(
    readonly peerId: string,
    private socket: Socket,
    config: RTCConfiguration,
    private onOpen: () => void,
    private onClose: () => void,
  ) {
    this.pc = new RTCPeerConnection(config);
    const channel = this.pc.createDataChannel('chunks', { ordered: true });
    this.direct = new DirectWire(channel);
    this.direct.onMessage = (data) => this.handleMessage(data);
    this.direct.onClose = () => this.directEnded();
    channel.onopen = () => {
      directFailures = 0;
      this.use(this.direct);
    };
    this.pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('signal:ice', { to: peerId, kind: 'listener', candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.directEnded();
    };
    this.relayTimer = window.setTimeout(() => this.askRelay(), directFailures >= 2 ? 0 : RELAY_AFTER_MS);
    window.setTimeout(() => {
      if (!this.isOpen) this.close();
    }, CONNECT_TIMEOUT_MS);
  }

  get isOpen() {
    return Boolean(this.wire?.isOpen);
  }

  /** How this contributor's segments are arriving. */
  get via(): 'direct' | 'relay' {
    return this.wire?.kind ?? 'direct';
  }

  async offer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.socket.emit('signal:offer', { to: this.peerId, sdp: offer.sdp });
  }

  async acceptAnswer(sdp: string) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    for (const candidate of this.iceQueue.splice(0)) await this.pc.addIceCandidate(candidate);
  }

  async addIce(candidate: RTCIceCandidateInit) {
    if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate);
    else this.iceQueue.push(candidate);
  }

  private askRelay() {
    if (this.closed || this.relay || this.direct.isOpen) return;
    const relay = new RelayWire(this.socket, this.peerId, 'listener');
    this.relay = relay;
    relay.onMessage = (data) => this.handleMessage(data);
    relay.onClose = () => {
      if (this.relay === relay) this.relay = null;
      // Nothing left to carry requests, and the direct connection isn't coming either.
      if (this.wire === relay || (!this.wire && this.directDead())) this.close();
    };
    this.socket.emit('relay:open', { to: this.peerId });
  }

  /** The contributor agreed to answer through the tracker. */
  relayAccepted() {
    if (this.closed || !this.relay) return;
    this.relay.open();
    if (!this.wire) this.use(this.relay);
  }

  relayReceive(data: Payload) {
    this.relay?.receive(data);
  }

  relayClosed() {
    this.relay?.close(false);
  }

  private directDead() {
    return this.directOver || this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed';
  }

  /** The direct connection failed, or closed after working. */
  private directEnded() {
    if (this.closed || this.directOver) return;
    this.directOver = true;
    if (this.wire === this.direct) {
      // The same thing that closes a contributor's tab. Waiting requests move on at once.
      this.close();
      return;
    }
    if (!this.wire) directFailures++;
    // On the relay already, or about to be.
    window.clearTimeout(this.relayTimer);
    if (!this.relay) this.askRelay();
  }

  /** Starts sending requests on this path. A direct one replaces the relay once nothing is in flight. */
  private use(wire: Wire) {
    if (this.closed) return;
    if (this.wire === wire) return;
    if (this.wire && this.pending.size > 0) return;
    const first = !this.wire;
    this.wire = wire;
    if (wire === this.direct) {
      window.clearTimeout(this.relayTimer);
      this.relay?.close();
    }
    if (!first) return;
    this.lastHeard = Date.now();
    // A frozen peer never closes its connection, so listen for silence instead of waiting.
    this.pingTimer = window.setInterval(() => {
      const limit = this.wire?.kind === 'relay' ? RELAY_SILENCE_LIMIT_MS : SILENCE_LIMIT_MS;
      if (Date.now() - this.lastHeard > limit) this.close();
      else this.send({ type: 'ping' });
    }, PING_MS);
    this.onOpen();
  }

  /** Lower is better: slow, busy and unreliable peers all cost more. */
  cost() {
    return ((this.latencyMs + 20) * (1 + this.inflight)) / Math.max(this.success, 0.05);
  }

  recordResult(ok: boolean, latencyMs?: number) {
    this.success = this.success * 0.7 + (ok ? 0.3 : 0);
    if (latencyMs !== undefined) this.latencyMs = this.latencyMs * 0.7 + latencyMs * 0.3;
  }

  private handleMessage(data: Payload) {
    this.lastHeard = Date.now();
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.type === 'chunk') {
        this.lastProgress = Date.now();
        this.incoming = { id: message.chunkId, size: message.size, parts: [], received: 0 };
      } else if (message.type === 'miss') {
        this.pending.get(message.chunkId)?.reject(new PeerFailure('miss'));
      }
      return;
    }
    const incoming = this.incoming;
    if (!incoming) return;
    this.lastProgress = Date.now();
    incoming.parts.push(data);
    incoming.received += data.byteLength;
    if (incoming.received < incoming.size) return;
    this.incoming = null;
    // A slow answer can arrive after its timeout. Nobody is waiting, so it is dropped here.
    const waiter = this.pending.get(incoming.id);
    if (!waiter) return;
    const whole = new Uint8Array(incoming.received);
    let offset = 0;
    for (const part of incoming.parts) {
      whole.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    waiter.resolve(whole.buffer);
  }

  request(chunkId: string, signal: AbortSignal): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) return reject(new PeerFailure('peer-left'));
      const started = Date.now();
      const stallMs = this.via === 'relay' ? RELAY_STALL_MS : STALL_MS;
      const finish = () => {
        window.clearInterval(timer);
        this.pending.delete(chunkId);
        this.inflight--;
        signal.removeEventListener('abort', onAbort);
        // A direct connection that opened during a relayed request takes over now.
        if (this.pending.size === 0 && this.wire !== this.direct && this.direct.isOpen) this.use(this.direct);
      };
      const onAbort = () => {
        finish();
        this.send({ type: 'cancel', chunkId });
        reject(new DOMException('Aborted', 'AbortError'));
      };
      // Requests to one peer are answered in turn, so progress on any of them counts for all.
      const timer = window.setInterval(() => {
        const now = Date.now();
        if (now - Math.max(this.lastProgress, started) < stallMs && now - started < CHUNK_LIMIT_MS) return;
        finish();
        this.send({ type: 'cancel', chunkId });
        reject(new PeerFailure('timeout'));
      }, 250);
      this.inflight++;
      this.pending.set(chunkId, {
        resolve: (bytes) => {
          finish();
          resolve(bytes);
        },
        reject: (err) => {
          finish();
          reject(err);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      this.send({ type: 'get', chunkId });
    });
  }

  send(message: object) {
    this.wire?.send(JSON.stringify(message));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.relayTimer);
    // Rejecting now moves every waiting request to another peer immediately.
    for (const waiter of [...this.pending.values()]) waiter.reject(new PeerFailure('peer-left'));
    this.relay?.close();
    this.direct.close();
    this.pc.close();
    this.onClose();
  }
}

const links = new Map<string, PeerLink>();
const retryAt = new Map<string, number>();
const badCopies = new Map<string, number>();
const holdersByTrack = new Map<string, Record<number, string[]>>();
const names: Record<string, string> = {};
let currentTrackId: string | null = null;
let refreshTimer: number | undefined;
let boundSocket: Socket | null = null;
const waiters: (() => void)[] = [];
let onPeersChanged: (names: string[]) => void = () => {};
let lastListenerState: 'playing' | 'waiting' | 'paused' | null = null;

const wake = () => {
  for (const waiter of waiters.splice(0)) waiter();
};

const holdersOf = (trackId: string | null) => (trackId ? holdersByTrack.get(trackId) : undefined) ?? {};
const holdsCurrent = (peerId: string) => Object.values(holdersOf(currentTrackId)).some((ids) => ids.includes(peerId));

function announcePeers() {
  onPeersChanged([...links.values()].filter((link) => link.isOpen && holdsCurrent(link.peerId)).map((link) => names[link.peerId] ?? 'Peer'));
}

export function watchConnectedPeers(listener: (names: string[]) => void) {
  onPeersChanged = listener;
}

function bind(socket: Socket) {
  if (boundSocket === socket) return;
  boundSocket = socket;
  socket.on('play:peers', (data: { trackId: string; peers: Record<number, string[]>; names: Record<string, string> }) => {
    holdersByTrack.set(data.trackId, data.peers);
    Object.assign(names, data.names);
    connectToHolders(data.peers).catch(() => {});
    announcePeers();
    wake();
  });
  socket.on('signal:answer', ({ from, sdp }: { from: string; sdp: string }) => {
    links.get(from)?.acceptAnswer(sdp).catch(() => links.get(from)?.close());
  });
  socket.on('signal:ice', ({ from, kind, candidate }: { from: string; kind: string; candidate: RTCIceCandidateInit }) => {
    if (kind === 'contributor') links.get(from)?.addIce(candidate).catch(() => {});
  });
  socket.on('relay:accept', ({ from }: { from: string }) => links.get(from)?.relayAccepted());
  socket.on('relay:data', ({ from, data }: { from: string; data: Payload }) => links.get(from)?.relayReceive(data));
  socket.on('relay:close', ({ from }: { from: string }) => links.get(from)?.relayClosed());
  // The tracker forgets every relay when this phone's connection to it drops.
  socket.on('disconnect', () => {
    for (const link of [...links.values()]) link.relayClosed();
  });
}

async function connectToHolders(holders: Record<number, string[]>) {
  const socket = getSocket();
  const config = await getRtcConfig();
  // Connect to whoever holds the most of this track first. The tracker lists each segment's
  // holders best first, so among equals, the better-scoring peer wins the earlier place.
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const ids of Object.values(holders)) {
    ids.forEach((id, position) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      firstSeen.set(id, Math.min(firstSeen.get(id) ?? position, position));
    });
  }
  const ranked = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!);
  for (const peerId of ranked) {
    if (links.size >= MAX_LINKS) break;
    if (links.has(peerId) || Date.now() < (retryAt.get(peerId) ?? 0)) continue;
    const link: PeerLink = new PeerLink(
      peerId,
      socket,
      config,
      () => {
        announcePeers();
        wake();
      },
      () => {
        if (links.get(peerId) === link) links.delete(peerId);
        retryAt.set(peerId, Date.now() + RETRY_AFTER_MS);
        announcePeers();
        // With more contributors than connections, replace this one straight away.
        if (currentTrackId) connectToHolders(holdersOf(currentTrackId)).catch(() => {});
      },
    );
    links.set(peerId, link);
    link.offer().catch(() => link.close());
  }
}

/** Finds peers for a track. Returns once they are connected, or quickly if there are none. */
export async function prepareTrack(trackId: string, maxWaitMs = 1500): Promise<void> {
  const socket = getSocket();
  bind(socket);
  currentTrackId = trackId;
  holdersByTrack.delete(trackId);
  badCopies.clear();
  announcePeers();
  socket.emit('play:request', { trackId, fromIdx: 0 });

  window.clearInterval(refreshTimer);
  // Contributors come, go and store more during a song, so keep asking who has what.
  // This is also what lets the music resume by itself when a contributor returns.
  refreshTimer = window.setInterval(() => {
    if (!currentTrackId) return;
    const current = getSocket();
    current.emit('play:request', { trackId: currentTrackId, fromIdx: 0 });
    // After a dropped connection the server has forgotten this, so keep repeating it.
    if (lastListenerState) current.emit('play:status', { state: lastListenerState });
  }, REFRESH_MS);

  const deadline = Date.now() + maxWaitMs;
  let firstOpenAt = 0;
  while (Date.now() < deadline) {
    const useful = [...links.values()].filter((link) => holdsCurrent(link.peerId));
    if (useful.some((link) => link.isOpen)) {
      // Give the others a moment too, or the first burst of requests all goes to one peer.
      firstOpenAt ||= Date.now();
      if (useful.every((link) => link.isOpen) || Date.now() - firstOpenAt >= SPREAD_GRACE_MS) return;
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      continue;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      window.setTimeout(resolve, Math.max(0, deadline - Date.now()));
    });
    const holders = holdersByTrack.get(trackId);
    if (holders && Object.keys(holders).length === 0) return;
  }
}

/** Learns who holds another track, for pre-fetching, without marking it as playing. */
export async function lookUpTrack(trackId: string, maxWaitMs = 1500): Promise<void> {
  const socket = getSocket();
  bind(socket);
  holdersByTrack.delete(trackId);
  socket.emit('play:request', { trackId, fromIdx: 0, lookupOnly: true });
  const deadline = Date.now() + maxWaitMs;
  while (!holdersByTrack.has(trackId) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      window.setTimeout(resolve, Math.max(0, deadline - Date.now()));
    });
  }
}

export function stopPeers() {
  window.clearInterval(refreshTimer);
  currentTrackId = null;
  holdersByTrack.clear();
  boundSocket?.emit('play:stop');
  for (const link of [...links.values()]) link.close();
  retryAt.clear();
  announcePeers();
}

const isBad = (peerId: string, chunkId: string) => (badCopies.get(`${peerId}:${chunkId}`) ?? 0) > Date.now();

/**
 * Puts items in a random order where each one's chance of coming first is proportional to its
 * weight. Always taking the single best peer would starve the rest: one never measured looks
 * worse than one already measured, so it would never get a chance, and never earn.
 */
function weightedOrder<T extends { weight: number }>(items: T[]): T[] {
  const left = [...items];
  const out: T[] = [];
  while (left.length) {
    const total = left.reduce((sum, item) => sum + item.weight, 0);
    let pick = Math.random() * total;
    let index = left.findIndex((item) => (pick -= item.weight) <= 0);
    if (index < 0) index = left.length - 1;
    out.push(...left.splice(index, 1));
  }
  return out;
}

/**
 * Connected peers holding this segment, in the order to ask them. Better peers (reliable, fast,
 * not busy) are more likely to come first, but every working peer gets its share.
 */
export function peerSourcesFor(trackId: string, idx: number, chunkId: string): PeerSource[] {
  const ids = holdersOf(trackId)[idx] ?? [];
  const candidates = ids
    .map((id) => links.get(id))
    .filter((link): link is PeerLink => Boolean(link?.isOpen) && !isBad(link!.peerId, chunkId))
    .map((link) => ({ link, weight: 1 / link.cost() }));
  return weightedOrder(candidates)
    .map(({ link }) => ({
      peerId: link.peerId,
      name: names[link.peerId] ?? 'Peer',
      via: () => link.via,
      fetch: async (id, signal) => {
        const started = performance.now();
        const bytes = await link.request(id, signal);
        link.recordResult(true, performance.now() - started);
        return bytes;
      },
      reportBad: (id) => {
        // Avoid this copy for long enough that the contributor can replace it, then try again.
        badCopies.set(`${link.peerId}:${id}`, Date.now() + BAD_COPY_RETRY_MS);
        link.recordResult(false);
        link.send({ type: 'bad', chunkId: id });
        boundSocket?.emit('stats:failure', { peerSessionId: link.peerId, reason: 'hash-mismatch' });
      },
      reportFailure: (reason) => {
        link.recordResult(false);
        boundSocket?.emit('stats:failure', { peerSessionId: link.peerId, reason });
      },
    }));
}

/** Sent only after the hash matched. This is what the contributor gets paid for. */
export function confirmReceipt(receipt: { chunkId: string; peerSessionId: string; latencyMs: number }) {
  boundSocket?.emit('receipt:confirm', receipt);
}

export function reportListenerState(state: 'playing' | 'waiting' | 'paused') {
  lastListenerState = state;
  boundSocket?.emit('play:status', { state });
}
