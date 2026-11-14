import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { adminRouter } from './admin/index.js';
import { authRouter, requireAuth } from './auth/index.js';
import { catalogRouter } from './catalog/index.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { errorHandler, HttpError, isOnThisComputer } from './http.js';
import { joinRouter, labRouter } from './lab/index.js';
import { libraryRouter } from './library/index.js';
import { contributorRouter, runPayout } from './ledger/index.js';
import { paymentsRouter, subscriptionRouter, webhookHandler } from './payments/index.js';
import { startPhoneLink, stopPhoneLink } from './lab/phoneLink.js';
import { seederRouter } from './seeder/index.js';
import { coverDir } from './seeder/storage.js';
import { createTracker } from './tracker/index.js';

const db = await openDb();
const app = express();

app.set('trust proxy', 'loopback');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
        frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https://*.razorpay.com'],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    // The demo also runs over plain http://localhost, where these only cause warnings.
    strictTransportSecurity: false,
    crossOriginOpenerPolicy: false,
  }),
);
// The webhook's signature covers the exact bytes sent, so it must arrive before JSON parsing.
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '256kb' }), webhookHandler(db));
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => {
  // `local` is true only on the computer running PeerBeats, where the Lab and its links belong.
  res.json({ app: 'peerbeats', ok: true, demoMode: config.demoMode, local: isOnThisComputer(req) });
});

// Connection settings for WebRTC. Phones connect directly when their networks allow it. When
// they don't, the tracker relays between them, so a TURN server is optional.
app.get('/api/rtc-config', requireAuth, (_req, res) => {
  if (config.forceRelay) {
    // No way to connect directly, so everything takes the relay.
    res.json({ iceServers: [], iceTransportPolicy: 'relay' });
    return;
  }
  const iceServers: Record<string, string>[] = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  if (config.turnUrl) {
    iceServers.push({ urls: config.turnUrl, username: config.turnUsername, credential: config.turnPassword });
  }
  res.json({ iceServers });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  PeerBeats is running at http://localhost:${config.port}\n`);
  // Lab only: phones reach this computer through the phone link, wherever they are.
  if (config.demoMode && config.phoneLink) startPhoneLink(config.port);
});
const tracker = createTracker(server, db);

app.use('/api', authRouter(db));
app.use('/api', catalogRouter(db));
app.use('/api', libraryRouter(db));
app.use('/api/admin', adminRouter(db, tracker));
app.use('/api/payments', paymentsRouter(db));
app.use('/api', subscriptionRouter(db));
app.use('/api', contributorRouter(db));
if (config.demoMode) {
  app.use('/api/lab', labRouter(tracker, db));
  app.use('/api/join', joinRouter());
}
app.use('/seeder', seederRouter(db, tracker));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'No such endpoint.')));

app.use('/covers', express.static(coverDir(), { maxAge: '1d' }));
app.use(
  express.static(config.webDist, {
    setHeaders: (res, file) => {
      // These two decide which version people get, so browsers must always check for new ones.
      if (/(sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);
app.get('*', (_req, res) => {
  const index = path.join(config.webDist, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(503).send('The web app is not built yet. Run: npm run build');
});
app.use(errorHandler);

const payoutTimer = setInterval(() => {
  runPayout(db).catch((err) => console.error('[ledger] payout:', err));
}, config.payoutCycleSec * 1000);
payoutTimer.unref();

let stopping = false;
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  stopPhoneLink();
  server.close();
  server.closeAllConnections();
  await db.close();
  process.exit(exitCode);
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Close the other app, or set a different PORT in .env.\n`);
  } else {
    console.error(err);
  }
  shutdown(1);
});

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('SIGHUP', () => shutdown());
