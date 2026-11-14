import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Two copies of every encrypted segment:
 *   hot/    the copy served day to day. It is the one that can go bad.
 *   origin/ the protected master, used to recover when a hash check fails.
 */
export type Tier = 'hot' | 'origin';

export const chunkPath = (tier: Tier, trackId: string, idx: number) =>
  path.join(config.storageDir, tier, trackId, `${idx}.bin`);

export const coverDir = () => path.join(config.storageDir, 'covers');

export function writeChunk(trackId: string, idx: number, bytes: Buffer) {
  for (const tier of ['hot', 'origin'] as const) {
    const file = chunkPath(tier, trackId, idx);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

export const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
