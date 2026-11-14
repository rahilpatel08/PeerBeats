import crypto from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../auth/index.js';
import { config, paymentsConfigured } from '../config.js';
import type { Db } from '../db.js';
import { HttpError, wrap } from '../http.js';
import { accessOf } from './access.js';

type PlanName = keyof typeof config.plans;

const PORTAL_SETTING = 'test_portal_active';
const portalBody = z.object({ code: z.string().max(100) });

/** The built-in test checkout. It takes no card details and moves no money. */
export async function portalActive(db: Pick<Db, 'query'>) {
  if (!config.demoMode) return false;
  const { rows } = await db.query<{ value: string }>('select value from app_settings where key = $1', [PORTAL_SETTING]);
  return rows[0]?.value === 'true';
}

const orderBody = z.object({ plan: z.enum(['monthly', 'credits']) });
const verifyBody = z.object({
  razorpay_order_id: z.string().min(1).max(100),
  razorpay_payment_id: z.string().min(1).max(100),
  razorpay_signature: z.string().min(1).max(200),
});

/** Only Razorpay takes a fee. Test payments never went through a gateway, so nothing is deducted. */
export const netOf = (grossPaise: number, source: string) =>
  source === 'razorpay' ? grossPaise - Math.round((grossPaise * config.gatewayFeePct) / 100) : grossPaise;

const hmacHex = (message: string | Buffer, secret: string) => crypto.createHmac('sha256', secret).update(message).digest('hex');

function sameSignature(expected: string, given: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Marks a payment captured and gives the buyer what they paid for. The browser's verify call
 * and Razorpay's webhook can both arrive, in either order, so only the first has any effect.
 */
export async function settlePayment(db: Db, orderId: string, paymentId: string, amountPaise?: number) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<any>('select * from payments where razorpay_order_id = $1 for update', [orderId]);
    const payment = rows[0];
    if (!payment) return 'not-found' as const;
    if (amountPaise !== undefined && amountPaise !== payment.amount_paise) return 'amount-mismatch' as const;
    if (payment.status === 'captured') return 'already' as const;

    await tx.query(
      `update payments set status = 'captured', razorpay_payment_id = $1, net_paise = $2, captured_at = now() where id = $3`,
      [paymentId, netOf(payment.amount_paise, payment.source), payment.id],
    );
    if (payment.plan === 'monthly') {
      await grantMonthly(tx, payment.user_id);
    } else {
      await tx.query(`insert into credit_ledger (user_id, delta, reason, ref_id) values ($1, $2, 'purchase', $3)`, [
        payment.user_id,
        config.plans.credits.credits,
        payment.id,
      ]);
    }
    return 'settled' as const;
  });
}

/**
 * A purchase on the built-in test checkout. It goes through the same settlement as a Razorpay
 * payment, so the plan, the revenue and the books all come from one recorded payment.
 */
export async function payWithTestPortal(db: Db, userId: string, plan: PlanName) {
  const orderId = `portal_${crypto.randomUUID()}`;
  await db.query(
    `insert into payments (user_id, razorpay_order_id, amount_paise, status, plan, source) values ($1, $2, $3, 'created', $4, 'test-portal')`,
    [userId, orderId, config.plans[plan].paise, plan],
  );
  return settlePayment(db, orderId, `portal_pay_${crypto.randomUUID()}`);
}

/** A renewal starts when the current month ends, so paying early never loses days. */
export async function grantMonthly(tx: Pick<Db, 'query'>, userId: string) {
  const { rows } = await tx.query<{ id: string }>(
    `update subscriptions
     set ends_at = greatest(ends_at, now()) + interval '${config.plans.monthly.days} days', status = 'active'
     where id = (select id from subscriptions where user_id = $1 and plan = 'monthly' order by ends_at desc limit 1)
     returning id`,
    [userId],
  );
  if (!rows.length) {
    await tx.query(
      `insert into subscriptions (user_id, plan, status, starts_at, ends_at)
       values ($1, 'monthly', 'active', now(), now() + interval '${config.plans.monthly.days} days')`,
      [userId],
    );
  }
}

export function subscriptionRouter(db: Db): Router {
  const router = Router();
  router.get(
    '/subscription',
    requireAuth,
    wrap(async (req: AuthedRequest, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        access: await accessOf(db, req.userId!),
        configured: paymentsConfigured(),
        portalActive: await portalActive(db),
        demoMode: config.demoMode,
        plans: {
          monthly: { paise: config.plans.monthly.paise, days: config.plans.monthly.days },
          credits: { paise: config.plans.credits.paise, credits: config.plans.credits.credits },
        },
      });
    }),
  );
  return router;
}

export function paymentsRouter(db: Db): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false });

  if (config.demoMode) {
    const codeLimiter = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false });

    router.post(
      '/portal',
      codeLimiter,
      requireAuth,
      wrap(async (req, res) => {
        const { code } = portalBody.parse(req.body);
        const given = crypto.createHash('sha256').update(code).digest();
        const expected = crypto.createHash('sha256').update(config.portalCode).digest();
        if (!crypto.timingSafeEqual(given, expected)) throw new HttpError(403, 'Wrong code.');
        await db.query(
          `insert into app_settings (key, value) values ($1, 'true') on conflict (key) do update set value = 'true'`,
          [PORTAL_SETTING],
        );
        res.json({ portalActive: true });
      }),
    );

    router.delete(
      '/portal',
      requireAuth,
      wrap(async (_req, res) => {
        await db.query(`insert into app_settings (key, value) values ($1, 'false') on conflict (key) do update set value = 'false'`, [PORTAL_SETTING]);
        res.json({ portalActive: false });
      }),
    );

    /**
     * The lab's free plan: the right code gives a monthly plan without paying. It is recorded as a
     * test payment like the built-in checkout, so contributors are still paid for what they deliver.
     */
    router.post(
      '/code',
      codeLimiter,
      requireAuth,
      wrap(async (req: AuthedRequest, res) => {
        const { code } = portalBody.parse(req.body);
        const given = crypto.createHash('sha256').update(code.trim().toLowerCase()).digest();
        const expected = crypto.createHash('sha256').update(config.portalCode.toLowerCase()).digest();
        if (!crypto.timingSafeEqual(given, expected)) throw new HttpError(403, 'That code isn\u2019t valid.');
        const before = await accessOf(db, req.userId!);
        // A second use while the plan runs would only stack free months, so it changes nothing.
        if (before.plan !== 'monthly') await payWithTestPortal(db, req.userId!, 'monthly');
        res.json({ access: await accessOf(db, req.userId!) });
      }),
    );

    router.post(
      '/portal/pay',
      limiter,
      requireAuth,
      wrap(async (req: AuthedRequest, res) => {
        const { plan } = orderBody.parse(req.body) as { plan: PlanName };
        if (!(await portalActive(db))) throw new HttpError(403, 'The payment portal is off.');
        await payWithTestPortal(db, req.userId!, plan);
        res.json({ access: await accessOf(db, req.userId!) });
      }),
    );
  }

  router.post(
    '/order',
    limiter,
    requireAuth,
    wrap(async (req: AuthedRequest, res) => {
      const { plan } = orderBody.parse(req.body) as { plan: PlanName };
      if (!paymentsConfigured()) throw new HttpError(503, 'Payments aren’t set up yet.');
      // The price comes from here, never from the browser.
      const amount = config.plans[plan].paise;
      const { rows } = await db.query<{ id: string }>(
        `insert into payments (user_id, amount_paise, status, plan) values ($1, $2, 'created', $3) returning id`,
        [req.userId, amount, plan],
      );
      const paymentRow = rows[0].id;
      const { keyId, keySecret, apiBase } = config.razorpay;
      let order: { id?: string } = {};
      let ok = false;
      try {
        const response = await fetch(`${apiBase}/v1/orders`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
            'Content-Type': 'application/json',
          },
          // Razorpay treats the receipt as a safeguard against creating an order twice.
          body: JSON.stringify({ amount, currency: 'INR', receipt: `pb_${paymentRow}`, notes: { plan } }),
          signal: AbortSignal.timeout(15000),
        });
        ok = response.ok;
        order = await response.json();
      } catch {
        ok = false;
      }
      if (!ok || !order.id) {
        await db.query(`update payments set status = 'failed' where id = $1`, [paymentRow]);
        throw new HttpError(502, 'Razorpay could not start this payment. Please try again.');
      }
      await db.query('update payments set razorpay_order_id = $1 where id = $2', [order.id, paymentRow]);
      res.json({ orderId: order.id, amount, currency: 'INR', keyId, plan });
    }),
  );

  router.post(
    '/verify',
    limiter,
    requireAuth,
    wrap(async (req: AuthedRequest, res) => {
      const body = verifyBody.parse(req.body);
      if (!paymentsConfigured()) throw new HttpError(503, 'Payments aren’t set up yet.');
      const { rows } = await db.query<{ razorpay_order_id: string; user_id: string }>(
        'select razorpay_order_id, user_id from payments where razorpay_order_id = $1',
        [body.razorpay_order_id],
      );
      // Razorpay says to use the order id stored on the server, and it must be this user's own.
      if (!rows[0] || rows[0].user_id !== req.userId) throw new HttpError(403, 'This payment isn’t yours.');
      const expected = hmacHex(`${rows[0].razorpay_order_id}|${body.razorpay_payment_id}`, config.razorpay.keySecret);
      if (!sameSignature(expected, body.razorpay_signature)) {
        throw new HttpError(400, 'This payment couldn’t be verified, so nothing was activated.');
      }
      const outcome = await settlePayment(db, rows[0].razorpay_order_id, body.razorpay_payment_id);
      res.json({ outcome, access: await accessOf(db, req.userId!) });
    }),
  );

  return router;
}

/** Razorpay's server-to-server confirmation. A backup for a buyer who closes the page. */
export function webhookHandler(db: Db): RequestHandler {
  const limiter = rateLimit({ windowMs: 60000, limit: 300, standardHeaders: true, legacyHeaders: false });
  const handle = wrap(async (req, res) => {
    const secret = config.razorpay.webhookSecret;
    if (!secret) throw new HttpError(503, 'The webhook isn’t set up.');
    const raw = req.body as Buffer;
    const signature = String(req.headers['x-razorpay-signature'] ?? '');
    if (!Buffer.isBuffer(raw) || !sameSignature(hmacHex(raw, secret), signature)) {
      throw new HttpError(400, 'Invalid signature.');
    }
    // Razorpay may deliver the same event more than once.
    const eventId = String(req.headers['x-razorpay-event-id'] ?? '');
    if (eventId) {
      const { rows } = await db.query(
        'insert into payment_events (event_id) values ($1) on conflict do nothing returning event_id',
        [eventId.slice(0, 200)],
      );
      if (!rows.length) {
        res.json({ status: 'duplicate' });
        return;
      }
    }
    const event = JSON.parse(raw.toString('utf8'));
    const entity = event?.payload?.payment?.entity;
    if ((event?.event === 'payment.captured' || event?.event === 'order.paid') && entity?.order_id && entity?.id) {
      const outcome = await settlePayment(db, entity.order_id, entity.id, entity.amount);
      res.json({ status: outcome });
      return;
    }
    res.json({ status: 'ignored' });
  });
  return (req, res, next) => limiter(req, res, () => handle(req, res, next));
}
