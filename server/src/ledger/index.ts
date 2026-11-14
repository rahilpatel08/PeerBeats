import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, type AuthedRequest } from '../auth/index.js';
import { config, paymentsConfigured } from '../config.js';
import type { Db } from '../db.js';
import { wrap } from '../http.js';
import { accessOf } from '../payments/access.js';

const DUPLICATE_WINDOW_MS = 3000;

export interface ReceiptInput {
  chunkId: string;
  contributorId: string;
  peerSessionId: string;
  listenerId: string;
  listenerSocketId: string;
  listenerTracks: Set<string>;
  sameIp: boolean;
}

export interface ReceiptResult {
  accepted: boolean;
  payable?: boolean;
  reason?: string;
  bytes?: number;
  idx?: number;
}

const recentReceipts = new Map<string, number>();

/**
 * Records a listener's confirmation that a segment passed its hash check. The size comes from
 * the catalog, not the claim. A refused receipt is still stored, with its reason, so the
 * figures can be audited, but it is never paid.
 */
export async function recordReceipt(db: Db, input: ReceiptInput): Promise<ReceiptResult> {
  const { chunkId, contributorId, listenerId } = input;
  const { rows: chunks } = await db.query<{ track_id: string; idx: number; size_bytes: number }>(
    'select track_id, idx, size_bytes from chunks where id = $1',
    [chunkId],
  );
  const chunk = chunks[0];
  if (!chunk) return { accepted: false, reason: 'unknown-chunk' };

  const store = async (reason: string | null): Promise<ReceiptResult> => {
    await db.query(
      `insert into transfer_receipts (contributor_id, listener_id, chunk_id, bytes, verified, payable, reject_reason)
       values ($1, $2, $3, $4, true, $5, $6)`,
      [contributorId, listenerId, chunkId, chunk.size_bytes, reason === null, reason],
    );
    return { accepted: reason === null, payable: reason === null, reason: reason ?? undefined, bytes: chunk.size_bytes, idx: chunk.idx };
  };

  if (contributorId === listenerId) return store('same-user');
  if (config.rejectSharedIp && input.sameIp) return store('shared-ip');
  if (!input.listenerTracks.has(chunk.track_id)) return store('not-playing-this-track');

  const { rows: holds } = await db.query('select 1 from peer_chunks where peer_session_id = $1 and chunk_id = $2', [input.peerSessionId, chunkId]);
  if (!holds.length) return store('peer-does-not-hold-it');

  // Paying listeners fund the pool, so an account with no plan can't earn anyone a share of it.
  const access = await accessOf(db, listenerId);
  if (!access.active) {
    const { rows: played } = await db.query(
      `select 1 from credit_ledger where user_id = $1 and reason = 'play' and ref_id = $2 and created_at > now() - interval '10 minutes' limit 1`,
      [listenerId, chunk.track_id],
    );
    if (!played.length) return store('listener-has-no-plan');
  }

  const key = `${contributorId}:${listenerId}:${chunkId}`;
  const now = Date.now();
  if (now - (recentReceipts.get(key) ?? 0) < DUPLICATE_WINDOW_MS) return store('duplicate');
  recentReceipts.set(key, now);
  if (recentReceipts.size > 20000) recentReceipts.clear();

  const { rows: usage } = await db.query<{ pair: string; total: string }>(
    `select coalesce(sum(bytes) filter (where contributor_id = $1), 0) as pair, coalesce(sum(bytes), 0) as total
     from transfer_receipts
     where listener_id = $2 and payable and created_at > now() - interval '1 hour'`,
    [contributorId, listenerId],
  );
  if (Number(usage[0].pair) + chunk.size_bytes > config.pairCapBytesPerHour) return store('pair-hourly-cap');
  if (Number(usage[0].total) + chunk.size_bytes > config.listenerCapBytesPerHour) return store('listener-hourly-cap');

  return store(null);
}

async function latestCarry(db: Pick<Db, 'query'>) {
  const { rows } = await db.query<{ carry_out_paise: number }>('select carry_out_paise from payout_cycles order by created_at desc limit 1');
  return rows[0]?.carry_out_paise ?? 0;
}

const portionOf = (net: number, recognized: number) => Math.min(Math.ceil(net / config.revenueCycles), net - recognized);

/**
 * Closes one payout cycle, as a single all-or-nothing step. Whole paise only: whatever can't
 * be divided evenly carries into the next cycle, so every paisa is always accounted for.
 * A cycle only runs when there's both money and delivery to match it. Otherwise each waits.
 */
export async function runPayout(db: Db) {
  return db.transaction(async (tx) => {
    const { rows: tallies } = await tx.query<{ contributor_id: string; bytes: string }>(
      `select contributor_id, sum(bytes) as bytes from transfer_receipts
       where verified and payable and cycle_id is null group by contributor_id`,
    );
    if (!tallies.length) return { ran: false as const, reason: 'No new deliveries to pay for.' };

    const { rows: payments } = await tx.query<{ id: string; net_paise: number; recognized_paise: number }>(
      `select id, net_paise, recognized_paise from payments where status = 'captured' and recognized_paise < net_paise`,
    );
    let revenue = 0;
    for (const p of payments) revenue += portionOf(p.net_paise, p.recognized_paise);
    const share = Math.floor((revenue * config.rewardPoolPct) / 100);
    const carryIn = await latestCarry(tx);
    const pool = share + carryIn;
    if (pool <= 0) return { ran: false as const, reason: 'No listener revenue to pay out yet.' };

    for (const p of payments) {
      await tx.query('update payments set recognized_paise = recognized_paise + $1 where id = $2', [portionOf(p.net_paise, p.recognized_paise), p.id]);
    }

    const totalBytes = tallies.reduce((sum, t) => sum + BigInt(t.bytes), 0n);
    const payouts = tallies.map((t) => ({
      userId: t.contributor_id,
      bytes: BigInt(t.bytes),
      paise: Number((BigInt(t.bytes) * BigInt(pool)) / totalBytes),
    }));
    const paid = payouts.reduce((sum, p) => sum + p.paise, 0);
    const { rows: cycle } = await tx.query<{ id: string }>(
      `insert into payout_cycles (revenue_paise, pool_share_paise, platform_paise, carry_in_paise, paid_paise, carry_out_paise, total_bytes)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [revenue, share, revenue - share, carryIn, paid, pool - paid, totalBytes.toString()],
    );
    const cycleId = cycle[0].id;
    for (const p of payouts) {
      if (p.paise > 0) {
        await tx.query(`insert into credit_ledger (user_id, delta, reason, ref_id) values ($1, $2, 'payout', $3)`, [p.userId, p.paise, cycleId]);
      }
    }
    await tx.query('update transfer_receipts set cycle_id = $1 where verified and payable and cycle_id is null', [cycleId]);
    return { ran: true as const, cycleId, revenue, pool, paid, carryOut: pool - paid, contributors: payouts.length };
  });
}

export async function revenueSummary(db: Db) {
  const { rows: money } = await db.query<any>(
    `select coalesce(sum(amount_paise), 0) as gross, coalesce(sum(net_paise), 0) as net, coalesce(sum(recognized_paise), 0) as recognized,
            count(*) as payments, count(*) filter (where source = 'razorpay') as razorpay_payments
     from payments where status = 'captured'`,
  );
  const { rows: cycles } = await db.query<any>(
    'select id, created_at, revenue_paise, pool_share_paise, platform_paise, carry_in_paise, paid_paise, carry_out_paise, total_bytes from payout_cycles order by created_at desc',
  );
  const sum = (key: string) => cycles.reduce((total: number, c: any) => total + Number(c[key]), 0);
  const { rows: refused } = await db.query<any>(
    `select reject_reason as reason, count(*) as count, sum(bytes) as bytes from transfer_receipts
     where not payable group by reject_reason order by count(*) desc`,
  );
  const { rows: unsettled } = await db.query<any>(
    `select coalesce(sum(bytes), 0) as bytes from transfer_receipts where verified and payable and cycle_id is null`,
  );
  const gross = Number(money[0].gross);
  const net = Number(money[0].net);
  return {
    grossPaise: gross,
    feePaise: gross - net,
    netPaise: net,
    recognizedPaise: Number(money[0].recognized),
    waitingPaise: net - Number(money[0].recognized),
    contributorSharePaise: sum('pool_share_paise'),
    platformPaise: sum('platform_paise'),
    paidPaise: sum('paid_paise'),
    carryPaise: cycles[0] ? Number(cycles[0].carry_out_paise) : 0,
    payments: Number(money[0].payments),
    razorpayPayments: Number(money[0].razorpay_payments),
    unsettledBytes: Number(unsettled[0].bytes),
    refused: refused.map((r: any) => ({ reason: r.reason, count: Number(r.count), bytes: Number(r.bytes) })),
    cycles: cycles.slice(0, 20).map((c: any) => ({
      id: c.id,
      at: c.created_at,
      revenuePaise: c.revenue_paise,
      poolPaise: c.pool_share_paise + c.carry_in_paise,
      paidPaise: c.paid_paise,
      totalBytes: Number(c.total_bytes),
    })),
    rules: {
      rewardPoolPct: config.rewardPoolPct,
      gatewayFeePct: config.gatewayFeePct,
      payoutCycleSec: config.payoutCycleSec,
      revenueCycles: config.revenueCycles,
      pairCapMbPerHour: config.pairCapBytesPerHour / 1024 / 1024,
      listenerCapMbPerHour: config.listenerCapBytesPerHour / 1024 / 1024,
      rejectSharedIp: config.rejectSharedIp,
    },
    paymentsConfigured: paymentsConfigured(),
  };
}

export function contributorRouter(db: Db): Router {
  const router = Router();
  // Counted per account. Everyone on one laptop or Wi-Fi shares an address, and each open
  // earnings page asks every few seconds, so counting by address would lock them out.
  const limiter = rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: AuthedRequest) => req.userId ?? 'anonymous',
    validate: false,
  });

  router.get(
    '/contributor/stats',
    requireAuth,
    limiter,
    wrap(async (req: AuthedRequest, res) => {
      const { rows: mine } = await db.query<any>(
        `select coalesce(sum(bytes) filter (where payable and created_at >= date_trunc('day', now())), 0) as today,
                coalesce(sum(bytes) filter (where payable), 0) as total,
                coalesce(sum(bytes) filter (where payable and cycle_id is null), 0) as unsettled,
                coalesce(sum(bytes) filter (where not payable), 0) as refused
         from transfer_receipts where contributor_id = $1 and verified`,
        [req.userId],
      );
      const { rows: earned } = await db.query<{ paise: string }>(
        `select coalesce(sum(delta), 0) as paise from credit_ledger where user_id = $1 and reason = 'payout'`,
        [req.userId],
      );
      const { rows: everyone } = await db.query<{ bytes: string }>(
        'select coalesce(sum(bytes), 0) as bytes from transfer_receipts where verified and payable and cycle_id is null',
      );
      const { rows: payments } = await db.query<{ net_paise: number; recognized_paise: number }>(
        `select net_paise, recognized_paise from payments where status = 'captured' and recognized_paise < net_paise`,
      );
      const nextRevenue = payments.reduce((sum, p) => sum + portionOf(p.net_paise, p.recognized_paise), 0);
      const nextPool = Math.floor((nextRevenue * config.rewardPoolPct) / 100) + (await latestCarry(db));
      const allUnsettled = BigInt(everyone[0].bytes);
      const estimate = allUnsettled > 0n ? Number((BigInt(mine[0].unsettled) * BigInt(nextPool)) / allUnsettled) : 0;
      res.set('Cache-Control', 'no-store');
      res.json({
        bytesToday: Number(mine[0].today),
        bytesTotal: Number(mine[0].total),
        bytesUnsettled: Number(mine[0].unsettled),
        bytesRefused: Number(mine[0].refused),
        earnedPaise: Number(earned[0].paise),
        estimatedNextPaise: estimate,
        payoutCycleSec: config.payoutCycleSec,
      });
    }),
  );

  router.get(
    '/contributor/earnings',
    requireAuth,
    limiter,
    wrap(async (req: AuthedRequest, res) => {
      const { rows } = await db.query<any>(
        `select l.delta, l.created_at, c.total_bytes,
                (select coalesce(sum(r.bytes), 0) from transfer_receipts r where r.cycle_id = l.ref_id and r.contributor_id = l.user_id) as bytes
         from credit_ledger l join payout_cycles c on c.id = l.ref_id
         where l.user_id = $1 and l.reason = 'payout' order by l.created_at desc limit 50`,
        [req.userId],
      );
      res.set('Cache-Control', 'no-store');
      res.json({ payouts: rows.map((r: any) => ({ at: r.created_at, paise: Number(r.delta), bytes: Number(r.bytes) })) });
    }),
  );

  return router;
}
