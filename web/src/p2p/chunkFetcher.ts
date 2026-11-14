import type { ChunkEvent, ManifestChunk } from '../lib/types';
import { decryptChunk, sha256Hex } from './crypto';
import { PeerFailure, peerSourcesFor, type PeerSource } from './peerManager';

export type ChunkEventInput = Omit<ChunkEvent, 'id' | 'at' | 'trackTitle'>;

/** No connected contributor could deliver a good copy right now. Worth trying again later. */
export class NoPeersError extends Error {
  constructor(idx: number) {
    super(`No contributor could deliver segment ${idx}.`);
  }
}

interface Prefetched {
  bytes: ArrayBuffer;
  source: string;
  peerId: string;
  via: 'direct' | 'relay';
}

/** Verified, still-encrypted segments of the next queued track. Memory only. */
const prefetched = new Map<string, Prefetched>();

/** Asks one peer. Returns null if it failed, so the caller can move on to the next. */
async function attempt(
  peer: PeerSource,
  chunk: ManifestChunk,
  signal: AbortSignal,
  onEvent: (event: ChunkEventInput) => void,
): Promise<Prefetched | null> {
  const started = performance.now();
  const base = { idx: chunk.idx, chunkId: chunk.id, source: peer.name, peerId: peer.peerId, via: peer.via() };
  let bytes: ArrayBuffer;
  try {
    bytes = await peer.fetch(chunk.id, signal);
  } catch (err) {
    if (signal.aborted) return null;
    const reason = err instanceof PeerFailure ? err.reason : 'peer-left';
    peer.reportFailure(reason);
    onEvent({ ...base, latencyMs: Math.round(performance.now() - started), bytes: 0, result: reason });
    return null;
  }
  const matches = (await sha256Hex(bytes)) === chunk.sha256;
  const latencyMs = Math.round(performance.now() - started);
  if (signal.aborted) return null;
  onEvent({ ...base, latencyMs, bytes: bytes.byteLength, result: matches ? 'ok' : 'hash-mismatch' });
  if (matches) return { bytes, source: peer.name, peerId: peer.peerId, via: base.via };
  peer.reportBad(chunk.id);
  return null;
}

/** Asks two peers at once and takes the first good answer. The slower one is cancelled. */
async function race(
  peers: PeerSource[],
  chunk: ManifestChunk,
  signal: AbortSignal,
  onEvent: (event: ChunkEventInput) => void,
): Promise<Prefetched | null> {
  const controllers = peers.map(() => new AbortController());
  const cancelAll = () => controllers.forEach((c) => c.abort());
  signal.addEventListener('abort', cancelAll, { once: true });
  try {
    return await new Promise<Prefetched | null>((resolve) => {
      let remaining = peers.length;
      peers.forEach((peer, i) => {
        attempt(peer, chunk, controllers[i].signal, onEvent).then((result) => {
          remaining--;
          if (result) {
            controllers.forEach((c, j) => j !== i && c.abort());
            resolve(result);
          } else if (remaining === 0) {
            resolve(null);
          }
        });
      });
    });
  } finally {
    signal.removeEventListener('abort', cancelAll);
  }
}

/**
 * Music comes from contributors only. Bytes are trusted once their SHA-256 matches the
 * manifest. When playback is about to run dry there's no time to wait out a slow peer,
 * so an urgent segment goes to two peers at once.
 */
async function fetchVerified(
  trackId: string,
  chunk: ManifestChunk,
  signal: AbortSignal,
  urgent: boolean,
  onEvent: (event: ChunkEventInput) => void,
): Promise<Prefetched> {
  const peers = peerSourcesFor(trackId, chunk.idx, chunk.id);
  if (urgent && peers.length >= 2) {
    const first = await race(peers.splice(0, 2), chunk, signal, onEvent);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (first) return first;
  }
  for (const peer of peers) {
    const result = await attempt(peer, chunk, signal, onEvent);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (result) return result;
  }
  throw new NoPeersError(chunk.idx);
}

/** Returns a segment's decrypted bytes, ready for the player. */
export async function fetchChunk(
  trackId: string,
  chunk: ManifestChunk,
  key: CryptoKey,
  signal: AbortSignal,
  urgent: boolean,
  onEvent: (event: ChunkEventInput) => void,
): Promise<ArrayBuffer> {
  const cached = prefetched.get(chunk.id);
  if (cached) {
    prefetched.delete(chunk.id);
    onEvent({ idx: chunk.idx, chunkId: chunk.id, source: cached.source, peerId: cached.peerId, via: cached.via, latencyMs: 0, bytes: cached.bytes.byteLength, result: 'cached' });
    return decryptChunk(key, cached.bytes);
  }
  const { bytes } = await fetchVerified(trackId, chunk, signal, urgent, onEvent);
  return decryptChunk(key, bytes);
}

/** Loads the given segments ahead of time so the next track starts instantly. */
export async function prefetchChunks(trackId: string, chunks: ManifestChunk[], signal: AbortSignal): Promise<void> {
  prefetched.clear();
  for (const chunk of chunks) {
    const result = await fetchVerified(trackId, chunk, signal, false, () => {});
    if (signal.aborted) return;
    prefetched.set(chunk.id, result);
  }
}
