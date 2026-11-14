export interface User {
  id: string;
  email: string;
  displayName: string;
  isContributor: boolean;
  isAdmin: boolean;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  genre: string | null;
  durationSec: number;
  coverUrl: string | null;
  license: string;
  segmentCount: number;
  playCount: number;
}

export interface ManifestChunk {
  id: string;
  idx: number; // 0 = init segment, 1..n = media segments
  sha256: string;
  size: number;
  start: number | null;
}

export interface Manifest {
  track: Track;
  mime: string;
  key: string; // base64 AES-256 key, held in memory only
  chunks: ManifestChunk[];
}

export interface ChunkEvent {
  id: number;
  at: number;
  trackTitle: string;
  idx: number;
  chunkId: string;
  source: string;
  peerId?: string; // set when a contributor delivered this, not the server
  via?: 'direct' | 'relay'; // relay: the two phones couldn't connect directly, so the tracker passed it on
  latencyMs: number;
  bytes: number;
  result: 'ok' | 'cached' | 'hash-mismatch' | 'timeout' | 'miss' | 'peer-left';
}
