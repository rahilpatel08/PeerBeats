import { api, authHeaders } from '../lib/api';
import { isInApp } from '../lib/install';
import { useAuth } from '../store/auth';
import { useContributor } from '../store/contributor';
import { allChunks, clearChunks, deleteChunk, getChunk, putChunk, selectChunkStore } from './chunkStore';
import { blockingCondition, watchConditions } from './conditions';
import { assertSecureContext, sha256Hex } from './crypto';
import { ServeHandler } from './serveHandler';
import { getSocket } from './socket';

const DOWNLOADS_AT_ONCE = 4;
const REPAIR_DELAY_MS = 1500;

interface Assigned {
  id: string;
  sha256: string;
  size: number;
}

const state = () => useContributor.getState();

let serve: ServeHandler | null = null;
let wakeLock: WakeLockSentinel | null = null;
let boundSocket: ReturnType<typeof getSocket> | null = null;

async function refreshUsage() {
  const chunks = await allChunks();
  state().set({
    chunksStored: chunks.length,
    bytesStored: chunks.reduce((sum, c) => sum + c.bytes.byteLength, 0),
  });
  return chunks;
}

async function requestWakeLock() {
  // The iPhone app keeps the screen on itself, through iOS, for as long as it is connected.
  if (isInApp()) {
    state().set({ wakeLock: 'on' });
    return;
  }
  if (!('wakeLock' in navigator)) {
    state().set({ wakeLock: 'unsupported' });
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      if (state().sharing) state().set({ wakeLock: 'off' });
    });
    state().set({ wakeLock: 'on' });
  } catch {
    // Browsers refuse this on a hidden tab or low battery. It is tried again on return.
    state().set({ wakeLock: 'off' });
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state().sharing && state().wakeLock !== 'on') requestWakeLock();
});

async function downloadVerified(id: string, sha256: string, tier = ''): Promise<ArrayBuffer> {
  const res = await fetch(`/seeder/chunks/${id}${tier}`, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  if ((await sha256Hex(bytes)) !== sha256) throw new Error('Hash mismatch');
  return bytes;
}

/** Stores what the tracker asked for, then reports it. The report brings the next batch. */
async function handleAssign({ chunks }: { chunks: Assigned[] }) {
  if (!state().sharing) return;
  if (!chunks.length) {
    state().set({ downloading: false });
    return;
  }
  state().set({ downloading: true });
  const stored: string[] = [];
  const queue = [...chunks];
  const worker = async () => {
    for (let next = queue.shift(); next && state().sharing; next = queue.shift()) {
      try {
        let bytes: ArrayBuffer;
        try {
          bytes = await downloadVerified(next.id, next.sha256);
        } catch {
          // The server's everyday copy may be damaged, so try its protected one.
          bytes = await downloadVerified(next.id, next.sha256, '?tier=origin');
        }
        await putChunk({ id: next.id, sha256: next.sha256, size: next.size, bytes });
        stored.push(next.id);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'QuotaExceededError') {
          state().set({ error: 'This browser has run out of storage space.' });
          queue.length = 0;
          getSocket().emit('peer:full');
        }
      }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, worker));
  await refreshUsage();
  if (!state().sharing) return;
  if (stored.length) {
    getSocket().emit('peer:have', { chunkIds: stored });
  } else {
    // The tracker offers these again later if it still needs them.
    state().set({ downloading: false });
  }
}

/** A listener said this copy failed its hash check. Check that, then replace it if true. */
async function repairCopy(chunkId: string) {
  const copy = await getChunk(chunkId);
  if (!copy || (await sha256Hex(copy.bytes)) === copy.sha256) return;
  await deleteChunk(chunkId);
  await refreshUsage();
  window.setTimeout(async () => {
    try {
      const bytes = await downloadVerified(chunkId, copy.sha256, '?tier=origin');
      await putChunk({ ...copy, bytes });
      await refreshUsage();
    } catch {
      // Sharing may have stopped. The next session only advertises copies that still verify.
    }
  }, REPAIR_DELAY_MS);
}

/** Tells the tracker who we are and what we hold. Runs again after any reconnect. */
async function register() {
  const socket = getSocket();
  const chunks = await refreshUsage();
  const good: string[] = [];
  for (const chunk of chunks) {
    // Storage can be damaged or cleared by the OS, so only advertise what still verifies.
    if ((await sha256Hex(chunk.bytes)) === chunk.sha256) good.push(chunk.id);
    else await deleteChunk(chunk.id);
  }
  const reply = await new Promise<{ peerSessionId?: string; error?: string }>((resolve) => {
    socket.emit('peer:hello', { quotaMb: state().quotaMb }, resolve);
  });
  if (reply.error) throw new Error(reply.error);
  socket.emit('peer:have', { chunkIds: good });
  await refreshUsage();
}

const onReconnect = () => {
  if (state().sharing) register().catch((err) => state().set({ error: err.message }));
};

// The tracker asks; answering straight away keeps working in a slowed-down background tab.
const onPing = () => {
  getSocket().emit('peer:heartbeat');
};

// The tracker dropped this session, so check everything held and rejoin.
const onRemoved = () => onReconnect();

export async function startSharing() {
  const s = state();
  if (s.sharing || s.starting) return;
  // Claimed before anything is awaited, so a second call meanwhile can't start a second session.
  s.set({ starting: true, error: null });
  // The person's own limits come first. It starts by itself once they're met again.
  const blocked = await blockingCondition();
  if (blocked) {
    state().set({ pausedFor: blocked, starting: false });
    return;
  }
  state().set({ pausedFor: null, servedBytes: 0, servedChunks: 0 });
  try {
    assertSecureContext();
    const userId = useAuth.getState().user?.id;
    if (!userId) throw new Error('Please log in first.');
    selectChunkStore(userId);
    navigator.storage?.persist?.().catch(() => {});
    await api('/api/me/contributor', { method: 'POST', body: { enabled: true } });

    const socket = getSocket();
    boundSocket = socket;
    socket.on('peer:assign', handleAssign);
    socket.on('connect', onReconnect);
    socket.on('peer:ping', onPing);
    socket.on('peer:removed', onRemoved);
    serve = new ServeHandler(socket, {
      onServed: (bytes) => state().set({ servedBytes: state().servedBytes + bytes, servedChunks: state().servedChunks + 1 }),
      onConnections: (count) => state().set({ connectedListeners: count }),
      onBadCopy: (chunkId) => {
        repairCopy(chunkId).catch(() => {});
      },
    });

    state().set({ sharing: true });
    if (!socket.connected) {
      socket.connect();
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Cannot reach the PeerBeats server.')), 8000);
        socket.once('connect', () => {
          window.clearTimeout(timer);
          resolve();
        });
      });
      // The 'connect' handler above already registered this session.
    } else {
      await register();
    }
    requestWakeLock();
  } catch (err) {
    stopSharing();
    state().set({ error: err instanceof Error ? err.message : 'Could not start sharing.' });
  } finally {
    state().set({ starting: false });
  }
}

function tearDown() {
  serve?.stop();
  serve = null;
  boundSocket?.off('peer:assign', handleAssign);
  boundSocket?.off('connect', onReconnect);
  boundSocket?.off('peer:ping', onPing);
  boundSocket?.off('peer:removed', onRemoved);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  state().set({ sharing: false, downloading: false, connectedListeners: 0, wakeLock: 'off' });
}

/** The person turned the switch off, so conditions changing must not turn it back on. */
export function turnOffSharing() {
  state().set({ pausedFor: null });
  stopSharing();
}

export function stopSharing() {
  boundSocket?.emit('peer:bye');
  boundSocket = null;
  tearDown();
}

export async function deleteStoredData() {
  const userId = useAuth.getState().user?.id;
  if (!userId) return;
  selectChunkStore(userId);
  await clearChunks();
  await refreshUsage();
}

export async function loadUsage() {
  const userId = useAuth.getState().user?.id;
  if (!userId) return;
  selectChunkStore(userId);
  await refreshUsage();
}

/** Pauses and resumes sharing as the person's Wi-Fi and battery limits stop or start applying. */
export async function checkConditions() {
  const blocked = await blockingCondition();
  const s = state();
  if (blocked && s.sharing) {
    stopSharing();
    state().set({ pausedFor: blocked });
  } else if (blocked && s.pausedFor) {
    s.set({ pausedFor: blocked });
  } else if (!blocked && s.pausedFor) {
    s.set({ pausedFor: null });
    await startSharing();
  }
}

watchConditions(() => {
  checkConditions().catch(() => {});
});
