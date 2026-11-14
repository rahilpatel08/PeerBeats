import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

// Tests point these elsewhere, so they can never touch your real data or settings.
const envFile = process.env.PEERBEATS_ENV_FILE || path.join(ROOT_DIR, '.env');
const dataDir = process.env.PEERBEATS_DATA_DIR || path.join(ROOT_DIR, 'data');
dotenv.config({ path: envFile });

const number = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) ? value : fallback;
};
const demoMode = (process.env.DEMO_MODE ?? 'true') === 'true';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change-me-to-a-long-random-string') {
  throw new Error('JWT_SECRET is missing. Copy .env.example to .env and set it, or use the launcher.');
}

export const config = {
  port: Number(process.env.PORT || 4173),
  // In a demo only this computer and the phone link may connect, never the local network.
  host: process.env.HOST || (demoMode ? '127.0.0.1' : '0.0.0.0'),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  databaseUrl: process.env.DATABASE_URL || '',
  demoMode,
  envFile,
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    apiBase: process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com',
  },
  // Turns on the built-in test checkout. Only exists in demo mode, because this code is guessable.
  portalCode: process.env.PORTAL_CODE || 'admin',
  plans: {
    monthly: { paise: 9900, days: 30, label: 'Monthly' },
    credits: { paise: 4900, credits: number('CREDIT_PACK_CREDITS', 500), label: 'Credit pack' },
  },
  // Razorpay's fee is estimated, because the real one isn't known when a payment is verified.
  gatewayFeePct: number('GATEWAY_FEE_PCT', 2.36),
  rewardPoolPct: 60,
  payoutCycleSec: number('PAYOUT_CYCLE_SEC', 60),
  // Each payment is paid out across this many cycles, not all in the first one.
  revenueCycles: number('REVENUE_CYCLES', 60),
  pairCapBytesPerHour: number('PAIR_CAP_MB_PER_HOUR', 100) * 1024 * 1024,
  listenerCapBytesPerHour: number('LISTENER_CAP_MB_PER_HOUR', 150) * 1024 * 1024,
  // On one laptop or one Wi-Fi network everyone shares an address, so a lab has to turn this off.
  // An empty value in .env means "use the default", not "off".
  rejectSharedIp: (process.env.REJECT_SHARED_IP || String(!demoMode)) === 'true',
  turnUrl: process.env.TURN_URL || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnPassword: process.env.TURN_PASSWORD || '',
  // The secure address phones anywhere use. On by default in a demo: a Cloudflare address that
  // lasts until PeerBeats stops. PUBLIC_URL names a permanent address of your own instead, and
  // TUNNEL_TOKEN runs the Cloudflare tunnel that serves it.
  phoneLink: (process.env.PHONE_LINK || 'on').toLowerCase() !== 'off',
  publicUrl: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  tunnelToken: (process.env.TUNNEL_TOKEN || '').trim(),
  // Sends every delivery through the relay. Only for checking the relay itself.
  forceRelay: process.env.FORCE_RELAY === 'true',
  pgliteDir: path.join(dataDir, 'pglite'),
  lockFile: path.join(dataDir, 'db.lock'),
  storageDir: process.env.PEERBEATS_STORAGE_DIR || path.join(ROOT_DIR, 'storage'),
  seedDir: path.join(ROOT_DIR, 'seed'),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  schemaFile: path.join(ROOT_DIR, 'server', 'sql', 'schema.sql'),
};

/** Test keys only until launch: a live key is refused, so no real money can move by accident. */
export const paymentsConfigured = () => {
  const { keyId, keySecret } = config.razorpay;
  return keyId.startsWith('rzp_test_') && keySecret.length > 0;
};
