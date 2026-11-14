import { create } from 'zustand';

export interface ContributorState {
  sharing: boolean;
  starting: boolean;
  error: string | null;
  quotaMb: number;
  chunksStored: number;
  bytesStored: number;
  downloading: boolean;
  connectedListeners: number;
  servedBytes: number;
  servedChunks: number;
  wakeLock: 'off' | 'on' | 'unsupported';
  wifiOnly: boolean;
  stopOnLowBattery: boolean;
  pausedFor: 'mobile-data' | 'low-battery' | null;
  set: (patch: Partial<ContributorState>) => void;
}

export function savedOption(name: string) {
  try {
    return localStorage.getItem(`peerbeats.${name}`) === 'true';
  } catch {
    return false;
  }
}

export function saveOption(name: string, value: boolean) {
  try {
    localStorage.setItem(`peerbeats.${name}`, String(value));
  } catch {
    // The choice still applies until this tab closes.
  }
}

export const useContributor = create<ContributorState>((set) => ({
  sharing: false,
  starting: false,
  error: null,
  quotaMb: 500,
  chunksStored: 0,
  bytesStored: 0,
  downloading: false,
  connectedListeners: 0,
  servedBytes: 0,
  servedChunks: 0,
  wakeLock: 'off',
  wifiOnly: savedOption('wifiOnly'),
  stopOnLowBattery: savedOption('stopOnLowBattery'),
  pausedFor: null,
  set: (patch) => set(patch),
}));
