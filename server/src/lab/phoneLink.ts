import { spawn, type ChildProcess } from 'node:child_process';
import { bin } from 'cloudflared';
import { config } from '../config.js';

/**
 * The phone link: the one secure address every phone uses, wherever it is.
 *
 * Phones need https for hashing and decryption, and a phone on another network needs an address
 * it can reach. By default this is a Cloudflare quick tunnel, which gives both with nothing to
 * set up on the phone. Its address is random and lasts until PeerBeats stops. A permanent
 * address needs a domain: PUBLIC_URL names it, and TUNNEL_TOKEN runs the tunnel that serves it.
 */
export type LinkState = 'off' | 'starting' | 'on' | 'error';

const START_TIMEOUT_MS = 30_000;
const CHECK_EVERY_MS = 60_000;
const MISSES_BEFORE_RESTART = 3;

let child: ChildProcess | null = null;
let state: LinkState = 'off';
let url: string | null = null;
let error: string | null = null;
/** True from start until stop, so a link that fails is started again without being asked. */
let wanted = false;
let port = config.port;
let failures = 0;
let misses = 0;
let retryTimer: NodeJS.Timeout | null = null;

export const phoneLinkStatus = () => ({
  state,
  url: state === 'on' ? url : null,
  error,
  /** False when the address changes each time PeerBeats starts. */
  permanent: Boolean(config.publicUrl),
});

function fail(message: string) {
  const proc = child;
  child = null;
  proc?.kill();
  state = 'error';
  url = null;
  error = message;
  if (!wanted) return;
  // Cloudflare or the internet may be briefly unavailable. Keep trying, less often each time.
  const delay = Math.min(60_000, 5_000 * 2 ** failures);
  failures++;
  retryTimer = setTimeout(launch, delay);
  retryTimer.unref();
}

/** A new address takes a few seconds to resolve, so don't show its QR code until it answers. */
async function waitUntilReachable(address: string, owner: ChildProcess) {
  for (let i = 0; i < 30 && child === owner; i++) {
    try {
      const res = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) break;
    } catch {
      // Not reachable yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (child !== owner) return;
  state = 'on';
  failures = 0;
  misses = 0;
  console.log(`  Phone link: ${address}\n`);
}

function launch() {
  retryTimer = null;
  if (!wanted || state === 'starting' || state === 'on') return;
  error = null;

  if (config.publicUrl && !config.tunnelToken) {
    // Something else already serves this address, such as a host or a tunnel run separately.
    url = config.publicUrl;
    state = 'on';
    return;
  }
  if (config.tunnelToken && !config.publicUrl) {
    state = 'error';
    error = 'TUNNEL_TOKEN is set without PUBLIC_URL. Set PUBLIC_URL in .env to the address of that tunnel.';
    return;
  }

  state = 'starting';
  url = null;
  // The token is read from the environment, so it never appears in the process list.
  const args = config.tunnelToken
    ? ['tunnel', '--no-autoupdate', 'run']
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TUNNEL_TOKEN: config.tunnelToken } });
  child = proc;

  const timeout = setTimeout(() => {
    if (child === proc && !url) fail('Cloudflare did not respond in time. Check that this computer has internet.');
  }, START_TIMEOUT_MS);

  const found = (address: string) => {
    if (url || child !== proc) return;
    url = address;
    clearTimeout(timeout);
    waitUntilReachable(address, proc);
  };
  const onData = (data: Buffer) => {
    const text = data.toString();
    if (config.tunnelToken) {
      if (/Registered tunnel connection/i.test(text)) found(config.publicUrl);
    } else {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
      if (match) found(match[0]);
    }
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  proc.on('error', () => {
    clearTimeout(timeout);
    if (child === proc) fail('The phone link tool could not start. Delete node_modules and run the launcher again.');
  });
  proc.on('exit', () => {
    clearTimeout(timeout);
    if (child === proc) fail('The phone link stopped. Starting it again.');
  });
}

export function startPhoneLink(onPort: number) {
  port = onPort;
  wanted = true;
  if (!retryTimer) launch();
}

export function stopPhoneLink() {
  wanted = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const proc = child;
  child = null;
  proc?.kill();
  state = 'off';
  url = null;
  error = null;
  failures = 0;
}

/** Gives every phone a new address. The old one stops working at once. */
export function restartPhoneLink(onPort: number) {
  stopPhoneLink();
  startPhoneLink(onPort);
}

// A quick tunnel can die without its process exiting, for example after a long sleep.
const watch = setInterval(async () => {
  const address = url;
  const owner = child;
  if (state !== 'on' || !address || !owner) return;
  let ok = false;
  try {
    ok = (await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(8000) })).ok;
  } catch {
    ok = false;
  }
  if (child !== owner || state !== 'on') return;
  misses = ok ? 0 : misses + 1;
  if (misses >= MISSES_BEFORE_RESTART) fail('The phone link stopped answering. Starting a new one.');
}, CHECK_EVERY_MS);
watch.unref();

process.on('exit', () => child?.kill());
