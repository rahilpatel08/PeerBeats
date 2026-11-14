import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatNumber, formatRupees } from '../lib/format';
import { getSocket } from '../p2p/socket';
import { useAuth } from '../store/auth';

interface Peer {
  sessionId: string;
  name: string;
  quotaMb: number;
  chunks: number;
  bytes: number;
  servedBytes: number;
  servedChunks: number;
  successPct: number;
  latencyMs: number | null;
  lastSeenAgoMs: number;
}

interface Network {
  at: number;
  peers: Peer[];
  listeners: { socketId: string; name: string; trackTitle: string | null; state: 'playing' | 'waiting' | 'paused' }[];
  tracks: { id: string; health: 'green' | 'amber' | 'red' }[];
  totals: { peerBytes: number; peerChunks: number; seededBytes: number; relayedBytes: number };
  transfers: { from: string; to: string }[];
  deliveries: { from: string; to: string; bytes: number }[];
  feed: { at: number; listener: string; from: string; trackTitle: string | null; idx: number; bytes: number }[];
  events: { at: number; kind: string; text: string }[];
}

interface Revenue {
  grossPaise: number;
  feePaise: number;
  netPaise: number;
  recognizedPaise: number;
  waitingPaise: number;
  contributorSharePaise: number;
  platformPaise: number;
  paidPaise: number;
  carryPaise: number;
  payments: number;
  razorpayPayments: number;
  unsettledBytes: number;
  refused: { reason: string; count: number; bytes: number }[];
  cycles: { id: string; at: string; revenuePaise: number; poolPaise: number; paidPaise: number; totalBytes: number }[];
  rules: { rewardPoolPct: number; payoutCycleSec: number; revenueCycles: number; pairCapMbPerHour: number; listenerCapMbPerHour: number; rejectSharedIp: boolean };
}

const REFUSAL_LABEL: Record<string, string> = {
  'same-user': 'own account',
  'shared-ip': 'same network as listener',
  'not-playing-this-track': 'listener wasn’t playing that song',
  'peer-does-not-hold-it': 'contributor doesn’t hold that segment',
  'listener-has-no-plan': 'listener has no plan',
  duplicate: 'repeated report',
  'pair-hourly-cap': 'hourly limit for the pair',
  'listener-hourly-cap': 'hourly limit for the listener',
};

const clock = (at: number | string) => new Date(at).toLocaleTimeString([], { hour12: false });

/** A plain table. Numeric columns are right-aligned in a monospace face so figures line up. */
function Table({ head, rows, numeric = [], empty, testId }: { head: string[]; rows: ReactNode[][]; numeric?: number[]; empty: string; testId?: string }) {
  const align = (i: number) => (numeric.includes(i) ? 'text-right font-mono text-xs' : '');
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b border-fg text-xs text-fg-3">
            {head.map((h, i) => (
              <th key={h} className={`whitespace-nowrap py-1 pr-3 text-left font-normal ${numeric.includes(i) ? 'text-right' : ''}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="py-1.5 text-fg-3">{empty}</td>
            </tr>
          ) : (
            rows.map((cells, r) => (
              <tr key={r} className="border-b border-line">
                {cells.map((cell, i) => (
                  <td key={i} className={`whitespace-nowrap py-1 pr-3 ${align(i)}`}>{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-fg pb-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <span className="text-xs text-fg-3">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Money() {
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<Revenue>('/api/admin/revenue').then(setRevenue).catch(() => {});
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);

  async function runNow() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ ran: boolean; reason?: string; paid?: number; contributors?: number }>('/api/admin/payout/run', { method: 'POST', body: {} });
      setMessage(result.ran ? `Paid ${formatRupees(result.paid ?? 0)} to ${result.contributors} contributor(s).` : result.reason ?? 'Nothing to pay.');
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'The payout failed.');
    } finally {
      setBusy(false);
    }
  }

  if (!revenue) return null;
  const test = revenue.payments - revenue.razorpayPayments;
  const money: [string, number][] = [
    ['Paid by listeners', revenue.grossPaise],
    ['Gateway fee', revenue.feePaise],
    ['Net', revenue.netPaise],
    ['Not paid out yet', revenue.waitingPaise],
    [`Contributors' share (${revenue.rules.rewardPoolPct}%)`, revenue.contributorSharePaise],
    ['Paid to contributors', revenue.paidPaise],
    ['Carried to the next payout', revenue.carryPaise],
    ["Platform's share", revenue.platformPaise],
  ];

  return (
    <>
      <Section
        title="Money"
        note={`${revenue.payments} payments: ${revenue.razorpayPayments} Razorpay, ${test} test. Payout every ${revenue.rules.payoutCycleSec} s, each payment spread over ${revenue.rules.revenueCycles}.`}
      >
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button onClick={runNow} disabled={busy} className="border border-fg px-3 py-1 text-sm font-semibold hover:bg-fg hover:text-ink disabled:opacity-60">
            {busy ? 'Paying' : 'Run payout now'}
          </button>
          {message && <span role="status" data-testid="payout-message" className="text-sm">{message}</span>}
        </div>
        <table className="mt-2 w-full max-w-xl text-sm">
          <tbody>
            {money.map(([label, paise]) => (
              <tr key={label} className="border-b border-line">
                <th scope="row" className="py-1 pr-4 text-left font-normal text-fg-2">{label}</th>
                <td data-testid={`money-${label}`} className="py-1 text-right font-mono text-xs">{formatRupees(paise)}</td>
                <td className="py-1 pl-3 text-right font-mono text-xs text-fg-3">{formatNumber(paise)} p</td>
              </tr>
            ))}
            <tr className="border-b border-line">
              <th scope="row" className="py-1 pr-4 text-left font-normal text-fg-2">Verified bytes waiting</th>
              <td className="py-1 text-right font-mono text-xs" colSpan={2}>{formatNumber(revenue.unsettledBytes)} B</td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title="Payouts">
        <Table
          head={['Time', 'Revenue', 'Pool', 'Paid', 'Bytes']}
          numeric={[1, 2, 3, 4]}
          empty="None yet."
          rows={revenue.cycles.map((c) => [clock(c.at), formatRupees(c.revenuePaise), formatRupees(c.poolPaise), formatRupees(c.paidPaise), formatNumber(c.totalBytes)])}
        />
      </Section>

      <Section
        title="Refused deliveries"
        note={`Limits ${revenue.rules.pairCapMbPerHour} MB/h per pair, ${revenue.rules.listenerCapMbPerHour} MB/h per listener. Same-network check ${revenue.rules.rejectSharedIp ? 'on' : 'off'}.`}
      >
        <Table
          head={['Reason', 'Count', 'Bytes']}
          numeric={[1, 2]}
          empty="None."
          testId="refused-list"
          rows={revenue.refused.map((r) => [REFUSAL_LABEL[r.reason] ?? r.reason, formatNumber(r.count), formatNumber(r.bytes)])}
        />
      </Section>
    </>
  );
}

export function Monitor() {
  const user = useAuth((s) => s.user);
  const [network, setNetwork] = useState<Network | null>(null);

  useEffect(() => {
    if (!user?.isAdmin) return;
    const socket = getSocket();
    const watch = () => socket.emit('admin:watch');
    socket.on('admin:network', setNetwork);
    socket.on('connect', watch);
    if (socket.connected) watch();
    return () => {
      socket.off('admin:network', setNetwork);
      socket.off('connect', watch);
      socket.emit('admin:unwatch');
    };
  }, [user?.isAdmin]);

  if (!user?.isAdmin) {
    return <p className="p-6 text-sm text-fg-2">The monitor is for the admin account.</p>;
  }
  if (!network) return <p className="p-6 text-sm text-fg-3">Loading.</p>;

  const { totals } = network;
  const playing = network.listeners.filter((l) => l.state === 'playing').length;
  const unavailable = network.tracks.filter((t) => t.health === 'red').length;
  const active = new Set(network.transfers.map((t) => `${t.from}>${t.to}`));
  const delivered = new Map(network.deliveries.map((d) => [`${d.from}>${d.to}`, d.bytes]));

  const summary: [string, ReactNode, string?][] = [
    ['Contributors online', network.peers.length, 'monitor-Contributors online'],
    ['Listening now', playing, 'monitor-Listening now'],
    ['Delivered by contributors', `${formatBytes(totals.peerBytes)} (${formatNumber(totals.peerBytes)} B, ${formatNumber(totals.peerChunks)} segments)`, 'monitor-Delivered by contributors'],
    ['Server to contributors, for storing', `${formatNumber(totals.seededBytes)} B`],
    // Contributors' own pieces, passed on for phones whose networks can't connect directly.
    ['Passed on by the relay', `${formatBytes(totals.relayedBytes)}`, 'monitor-Relayed'],
    ["Songs that can't play now", `${unavailable} of ${network.tracks.length}`, "monitor-Songs that can't play now"],
  ];

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg">Monitor</h1>
        <span className="font-mono text-xs text-fg-3">{clock(network.at)}</span>
      </div>

      <table className="mt-2 w-full max-w-xl text-sm">
        <tbody>
          {summary.map(([label, value, testId]) => (
            <tr key={label} className="border-b border-line">
              <th scope="row" className="py-1 pr-4 text-left font-normal text-fg-2">{label}</th>
              <td data-testid={testId} className="py-1 text-right font-mono text-xs">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Section title="Contributors">
        <Table
          head={['Name', 'Session', 'Segments', 'Stored B', 'Served B', 'Served segs', 'Success', 'Latency ms', 'Last heard s', 'Limit MB']}
          numeric={[2, 3, 4, 5, 6, 7, 8, 9]}
          empty="No one is sharing."
          rows={network.peers.map((p) => [
            p.name,
            <span className="font-mono text-xs">{p.sessionId.slice(0, 8)}</span>,
            formatNumber(p.chunks),
            formatNumber(p.bytes),
            formatNumber(p.servedBytes),
            formatNumber(p.servedChunks),
            `${p.successPct}%`,
            p.latencyMs ?? '-',
            (p.lastSeenAgoMs / 1000).toFixed(0),
            formatNumber(p.quotaMb),
          ])}
        />
      </Section>

      <Section title="Listeners">
        <Table
          head={['Name', 'State', 'Track']}
          empty="No one is listening."
          rows={network.listeners.map((l) => [l.name, l.state, l.trackTitle ?? '-'])}
        />
      </Section>

      <Section title="Bytes delivered, contributor to listener" note="bold: delivering in the last 4 s">
        <Table
          head={['From', ...network.listeners.map((l) => l.name)]}
          numeric={network.listeners.map((_, i) => i + 1)}
          empty="No one is sharing."
          rows={network.peers.map((p) => [
            p.name,
            ...network.listeners.map((l) => {
              const key = `${p.sessionId}>${l.socketId}`;
              const value = formatNumber(delivered.get(key) ?? 0);
              return active.has(key) ? <strong>{value}</strong> : value;
            }),
          ])}
        />
      </Section>

      <Money />

      <Section title="Events">
        <Table
          head={['Time', 'Event']}
          empty="None yet."
          testId="network-events"
          rows={network.events.map((e) => [<span className="font-mono text-xs">{clock(e.at)}</span>, e.text])}
        />
      </Section>

      <Section title="Latest verified segments">
        <Table
          head={['Time', 'Track', 'Segment', 'From', 'To', 'Bytes']}
          numeric={[2, 5]}
          empty="None yet."
          rows={network.feed.map((f) => [
            <span className="font-mono text-xs">{clock(f.at)}</span>,
            f.trackTitle ?? '-',
            f.idx === 0 ? 'header' : f.idx,
            f.from,
            f.listener,
            formatNumber(f.bytes),
          ])}
        />
      </Section>
    </div>
  );
}
