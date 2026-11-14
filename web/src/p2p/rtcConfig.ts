import { api } from '../lib/api';

let cached: Promise<RTCConfiguration> | null = null;

export function getRtcConfig(): Promise<RTCConfiguration> {
  cached ??= api<RTCConfiguration>('/api/rtc-config').catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}
