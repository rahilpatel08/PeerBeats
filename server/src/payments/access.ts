import type { Db } from '../db.js';

export interface Access {
  active: boolean;
  plan: 'monthly' | 'credits' | null;
  endsAt: string | null;
  credits: number;
}

const REPLAY_WINDOW = "interval '10 minutes'";

export async function accessOf(db: Pick<Db, 'query'>, userId: string): Promise<Access> {
  const { rows: monthly } = await db.query<{ ends_at: string }>(
    `select ends_at from subscriptions
     where user_id = $1 and plan = 'monthly' and status = 'active' and ends_at > now()
     order by ends_at desc limit 1`,
    [userId],
  );
  const { rows: balance } = await db.query<{ credits: string }>(
    `select coalesce(sum(delta), 0) as credits from credit_ledger where user_id = $1 and reason in ('purchase', 'play')`,
    [userId],
  );
  const credits = Number(balance[0].credits);
  if (monthly[0]) return { active: true, plan: 'monthly', endsAt: monthly[0].ends_at, credits };
  return { active: credits > 0, plan: credits > 0 ? 'credits' : null, endsAt: null, credits };
}

/**
 * Decides whether someone may have a track's key. A credit buys one play. Seeking, reloading
 * or pre-fetching isn't another play, so the same track is free again for 10 minutes.
 */
export async function allowPlay(db: Db, userId: string, trackId: string, chargeable: boolean): Promise<boolean> {
  const access = await accessOf(db, userId);
  if (access.plan === 'monthly') return true;
  const { rows: recent } = await db.query(
    `select 1 from credit_ledger
     where user_id = $1 and reason = 'play' and ref_id = $2 and created_at > now() - ${REPLAY_WINDOW} limit 1`,
    [userId, trackId],
  );
  if (recent.length) return true;
  if (!access.active) return false;
  if (!chargeable) return true;
  // The balance is checked inside the same statement, so two requests can't spend one credit.
  const { rows } = await db.query(
    `insert into credit_ledger (user_id, delta, reason, ref_id)
     select $1, -1, 'play', $2
     where (select coalesce(sum(delta), 0) from credit_ledger where user_id = $1 and reason in ('purchase', 'play')) >= 1
     returning id`,
    [userId, trackId],
  );
  return rows.length > 0;
}
