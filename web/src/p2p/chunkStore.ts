import { openDB, type IDBPDatabase } from 'idb';

/** Encrypted segments held for other listeners. This browser can't play them: it has no keys. */
export interface StoredChunk {
  id: string;
  sha256: string;
  size: number;
  bytes: ArrayBuffer;
}

const dbs = new Map<string, Promise<IDBPDatabase>>();
let currentUser = '';

// Each account gets its own store, so two contributor tabs on one laptop act as two real peers.
export function selectChunkStore(userId: string) {
  currentUser = userId;
}

function db() {
  const name = `peerbeats-chunks-${currentUser}`;
  let opened = dbs.get(name);
  if (!opened) {
    opened = openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore('chunks', { keyPath: 'id' });
      },
    });
    dbs.set(name, opened);
  }
  return opened;
}

export async function putChunk(chunk: StoredChunk) {
  await (await db()).put('chunks', chunk);
}

export async function getChunk(id: string): Promise<StoredChunk | undefined> {
  return (await db()).get('chunks', id);
}

export async function deleteChunk(id: string) {
  await (await db()).delete('chunks', id);
}

export async function allChunks(): Promise<StoredChunk[]> {
  return (await db()).getAll('chunks');
}

export async function clearChunks() {
  await (await db()).clear('chunks');
}
