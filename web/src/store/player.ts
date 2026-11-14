import { create } from 'zustand';
import type { ChunkEvent, Track } from '../lib/types';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'error';
export type RepeatMode = 'off' | 'all' | 'one';

export interface DeliveryStats {
  segments: number;
  bytes: number;
  hashFailures: number;
  recovered: number;
  bySource: Record<string, number>;
}

export const emptyStats = (): DeliveryStats => ({ segments: 0, bytes: 0, hashFailures: 0, recovered: 0, bySource: {} });

interface PlayerState {
  queue: Track[];
  index: number;
  current: Track | null;
  status: PlayerStatus;
  error: string | null;
  currentTime: number;
  duration: number;
  buffered: [number, number][];
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  log: ChunkEvent[];
  stats: DeliveryStats;
  debugOpen: boolean;
  connectedPeers: string[];
  peersChecked: boolean;
  waitingForPeers: boolean;
  needsPayment: boolean;
  set: (patch: Partial<PlayerState>) => void;
}

function savedVolume() {
  try {
    const value = Number(localStorage.getItem('peerbeats.volume'));
    return value > 0 && value <= 1 ? value : 0.9;
  } catch {
    return 0.9;
  }
}

export const usePlayer = create<PlayerState>((set) => ({
  queue: [],
  index: -1,
  current: null,
  status: 'idle',
  error: null,
  currentTime: 0,
  duration: 0,
  buffered: [],
  volume: savedVolume(),
  shuffle: false,
  repeat: 'off',
  log: [],
  stats: emptyStats(),
  debugOpen: false,
  connectedPeers: [],
  peersChecked: false,
  waitingForPeers: false,
  needsPayment: false,
  set: (patch) => set(patch),
}));
