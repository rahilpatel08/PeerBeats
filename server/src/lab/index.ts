import fs from 'node:fs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config, paymentsConfigured } from '../config.js';
import type { Db } from '../db.js';
import { HttpError, isOnThisComputer, wrap } from '../http.js';
import { portalActive } from '../payments/index.js';
import type { Tracker } from '../tracker/index.js';
import { phoneLinkStatus, restartPhoneLink, startPhoneLink, stopPhoneLink } from './phoneLink.js';

/** The custom header stops other websites open in this browser from sending the request. */
function localOnly(req: Request, _res: Response, next: NextFunction) {
  if (!isOnThisComputer(req) || req.headers['x-peerbeats-lab'] !== '1') {
    return next(new HttpError(403, 'This control only works on the laptop running PeerBeats.'));
  }
  next();
}

const paymentKeys = z.object({
  keyId: z.string().trim().regex(/^rzp_test_[A-Za-z0-9]+$/, 'Use a test key: it starts with rzp_test_. Live keys are refused until launch.'),
  keySecret: z.string().trim().regex(/^[A-Za-z0-9]{8,100}$/, 'That secret doesn\u2019t look right. Copy it again from your Dashboard.'),
  webhookSecret: z.string().trim().regex(/^[\x21-\x7e]{0,200}$/, 'The webhook secret has characters it can\u2019t contain.').default(''),
});

function saveEnv(values: Record<string, string>) {
  const lines = fs.existsSync(config.envFile) ? fs.readFileSync(config.envFile, 'utf8').split('\n') : [];
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at >= 0) lines[at] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  fs.writeFileSync(config.envFile, lines.join('\n'));
  // This file holds secrets, so only the owner of this Mac account may read it.
  fs.chmodSync(config.envFile, 0o600);
}

/** Anyone may read this much: the address to open PeerBeats at. Nothing about anyone. */
export function joinRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    const { state, url } = phoneLinkStatus();
    res.set('Cache-Control', 'no-store');
    res.json({ link: { state, url } });
  });
  return router;
}

/** Mounted only when DEMO_MODE=true. Every part of it answers only on the computer running PeerBeats. */
export function labRouter(tracker: Tracker, db: Db): Router {
  const router = Router();
  router.use((req, _res, next) => {
    if (!isOnThisComputer(req)) return next(new HttpError(403, 'The Lab only opens on the computer running PeerBeats.'));
    next();
  });

  router.get(
    '/status',
    wrap(async (req, res) => {
      const local = isOnThisComputer(req);
      res.set('Cache-Control', 'no-store');
      res.json({
        stage: 5,
        local,
        network: await tracker.labSummary(),
        link: phoneLinkStatus(),
        payments: { configured: paymentsConfigured(), portalActive: await portalActive(db) },
        rules: { rejectSharedIp: config.rejectSharedIp },
      });
    }),
  );

  router.post('/link', localOnly, (_req, res) => {
    startPhoneLink(config.port);
    res.json(phoneLinkStatus());
  });

  /** A new address. Every phone has to open the new one, so this is for when the old one leaked. */
  router.post('/link/new', localOnly, (_req, res) => {
    restartPhoneLink(config.port);
    res.json(phoneLinkStatus());
  });

  router.delete('/link', localOnly, (_req, res) => {
    stopPhoneLink();
    res.json(phoneLinkStatus());
  });

  /** Starts the next demo with empty delivery and payout records. Plans, payments and music stay. */
  router.post(
    '/reset-activity',
    localOnly,
    wrap(async (_req, res) => {
      await db.transaction(async (tx) => {
        await tx.query('delete from transfer_receipts');
        await tx.query(`delete from credit_ledger where reason = 'payout'`);
        await tx.query('delete from payout_cycles');
        await tx.query('update payments set recognized_paise = 0');
      });
      tracker.resetTotals();
      res.json({ cleared: true });
    }),
  );

  /** Saves the owner's Razorpay test keys to .env. The secret is never sent back to any page. */
  router.post(
    '/payment-keys',
    localOnly,
    wrap(async (req, res) => {
      const body = paymentKeys.parse(req.body);
      let check: globalThis.Response;
      try {
        check = await fetch(`${config.razorpay.apiBase}/v1/orders?count=1`, {
          headers: { Authorization: `Basic ${Buffer.from(`${body.keyId}:${body.keySecret}`).toString('base64')}` },
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new HttpError(502, 'Could not reach Razorpay. Check this laptop has internet.');
      }
      if (check.status === 401) throw new HttpError(400, 'Razorpay rejected those keys. Copy both again from your Dashboard, in Test Mode.');
      if (!check.ok) throw new HttpError(502, `Razorpay returned an error (${check.status}). Try again in a moment.`);

      saveEnv({ RAZORPAY_KEY_ID: body.keyId, RAZORPAY_KEY_SECRET: body.keySecret, RAZORPAY_WEBHOOK_SECRET: body.webhookSecret });
      config.razorpay.keyId = body.keyId;
      config.razorpay.keySecret = body.keySecret;
      config.razorpay.webhookSecret = body.webhookSecret;
      res.json({ configured: paymentsConfigured() });
    }),
  );

  return router;
}
