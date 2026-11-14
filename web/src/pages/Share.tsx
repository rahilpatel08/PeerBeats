import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatNumber, formatRupees } from '../lib/format';
import { conditionSupport } from '../p2p/conditions';
import { checkConditions, deleteStoredData, loadUsage, startSharing, turnOffSharing } from '../p2p/contributor';
import { saveOption, savedOption, useContributor } from '../store/contributor';

interface Stats {
  bytesToday: number;
  bytesTotal: number;
  bytesUnsettled: number;
  bytesRefused: number;
  earnedPaise: number;
  estimatedNextPaise: number;
  payoutCycleSec: number;
}
interface Payout {
  at: string;
  paise: number;
  bytes: number;
}

const bytes = (n: number) => `${formatNumber(n)} B`;

function Rows({ rows }: { rows: [string, ReactNode, string?][] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([label, value, testId]) => (
          <tr key={label} className="border-b border-line">
            <th scope="row" className="py-1 pr-4 text-left font-normal text-fg-2">{label}</th>
            <td data-testid={testId} className="py-1 text-right font-mono text-xs">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Earnings() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, e] = await Promise.all([
          api<Stats>('/api/contributor/stats'),
          api<{ payouts: Payout[] }>('/api/contributor/earnings'),
        ]);
        if (alive) {
          setStats(s);
          setPayouts(e.payouts);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load earnings.');
      }
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="mt-6">
      <h2 className="border-b border-fg pb-1 text-sm font-semibold">Money received <span className="font-normal text-fg-3">simulated rupees</span></h2>
      {error && <p role="alert" className="py-1 text-sm text-danger">{error}</p>}
      {stats && (
        <Rows
          rows={[
            ['Received so far', formatRupees(stats.earnedPaise), 'earn-Earned'],
            ['Next payout, estimated', formatRupees(stats.estimatedNextPaise), 'earn-Next payout, estimated'],
            ['Delivered today, verified', bytes(stats.bytesToday), 'earn-Delivered today'],
            ['Delivered in total, verified', bytes(stats.bytesTotal), 'earn-Delivered in total'],
            ['Waiting for the next payout', bytes(stats.bytesUnsettled)],
            ['Delivered but not counted', bytes(stats.bytesRefused)],
            ['Payout every', `${stats.payoutCycleSec} s`],
          ]}
        />
      )}
      {payouts.length > 0 && (
        <table className="mt-3 w-full text-sm" data-testid="payout-history">
          <thead>
            <tr className="border-b border-fg text-left text-xs text-fg-3">
              <th className="py-1 font-normal">Payout</th>
              <th className="py-1 text-right font-normal">Bytes</th>
              <th className="py-1 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            {payouts.map((p) => (
              <tr key={p.at} className="border-b border-line">
                <td className="py-1">{new Date(p.at).toLocaleTimeString([], { hour12: false })}</td>
                <td className="py-1 text-right">{formatNumber(p.bytes)}</td>
                <td className="py-1 text-right">{formatRupees(p.paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Share() {
  const c = useContributor();
  const [params, setParams] = useSearchParams();
  const [support, setSupport] = useState({ wifi: false, battery: false });

  const asked = params.get('autostart') === '1';

  useEffect(() => {
    conditionSupport().then(setSupport).catch(() => {});
    loadUsage().catch(() => {});
  }, []);

  // On arrival, and whenever something sends ?autostart=1 here (a new contributor, a role switch).
  // A contributor who left sharing on also gets it back when the app opens again.
  useEffect(() => {
    if (asked) setParams({}, { replace: true });
    const state = useContributor.getState();
    if ((asked || savedOption('keepSharing')) && !state.sharing && !state.starting) start();
    // Clearing the parameter stops a later visit from restarting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const status = c.pausedFor === 'mobile-data'
    ? 'Paused: on mobile data. Continues on Wi-Fi.'
    : c.pausedFor === 'low-battery'
      ? 'Paused: low battery. Continues when charging.'
      : c.starting
        ? 'Starting'
        : !c.sharing
          ? 'Sharing is off'
          : c.downloading
            ? 'Sharing active, still collecting music'
            : 'Sharing active';
  const on = c.sharing || c.pausedFor !== null;

  function start() {
    saveOption('keepSharing', true);
    startSharing();
  }
  function stop() {
    saveOption('keepSharing', false);
    turnOffSharing();
  }

  return (
    <div className="max-w-2xl p-4 sm:p-6">
      <div className="flex items-center justify-between gap-4 border-b border-fg pb-2">
        <h1 className="text-lg">Contribute</h1>
        <div className="flex items-center gap-3">
          <span role="status" data-testid="share-status" className={`text-sm ${c.sharing ? 'font-semibold' : 'text-fg-2'}`}>{status}</span>
          <button
            role="switch"
            aria-checked={on}
            aria-label="Share my storage and bandwidth"
            disabled={c.starting}
            onClick={() => (on ? stop() : start())}
            className={`relative h-6 w-11 shrink-0 rounded-full disabled:opacity-60 ${c.sharing ? 'bg-accent' : c.pausedFor ? 'bg-warn' : 'bg-ink-4'}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white ${on ? 'left-[1.375rem]' : 'left-0.5'}`} />
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-fg-2">
        Stores encrypted segments in this browser and uploads them to listeners over your connection. They can't be played from here.
        Turn off or close the page to stop. A phone stops when its screen locks.
      </p>
      {c.error && <p role="alert" className="mt-2 text-sm text-danger">{c.error}</p>}

      <Earnings />

      <section className="mt-6">
        <h2 className="border-b border-fg pb-1 text-sm font-semibold">This device</h2>
        <Rows
          rows={[
            ['Listeners connected', c.connectedListeners, 'share-Listeners connected'],
            ['Segments stored', c.chunksStored, 'share-Segments stored'],
            ['Bytes stored', bytes(c.bytesStored)],
            ['Storage limit', `${formatNumber(c.quotaMb)} MB`],
            ['Segments served', c.servedChunks, 'share-Segments served'],
            ['Data served', bytes(c.servedBytes), 'share-Data served'],
            ['Screen kept awake', c.wakeLock === 'on' ? 'yes' : c.wakeLock === 'unsupported' ? 'not supported here' : 'no'],
          ]}
        />
      </section>


      <section className="mt-6 text-sm">
        <h2 className="border-b border-fg pb-1 font-semibold">Settings</h2>
        <label className="mt-2 flex items-center gap-3 text-fg-2">
          Storage limit
          <input
            type="range"
            min={200}
            max={2048}
            step={50}
            value={c.quotaMb}
            disabled={c.sharing || c.starting}
            onChange={(e) => c.set({ quotaMb: Number(e.target.value) })}
            className="h-1 flex-1 accent-accent disabled:opacity-50"
          />
          <span className="w-20 text-right font-mono text-xs">{c.quotaMb} MB</span>
        </label>
        {c.sharing && <p className="text-xs text-fg-3">Turn sharing off to change the limit.</p>}
        <div className="mt-2 space-y-1 text-fg-2">
          {[
            { key: 'wifiOnly', label: 'Share on Wi-Fi only', checked: c.wifiOnly, supported: support.wifi, missing: 'This browser can’t tell Wi-Fi from mobile data.' },
            { key: 'stopOnLowBattery', label: 'Pause below 20% battery when not charging', checked: c.stopOnLowBattery, supported: support.battery, missing: 'This browser doesn’t report battery level.' },
          ].map((option) => (
            <label key={option.key} className={`flex items-start gap-2 ${option.supported ? '' : 'opacity-60'}`}>
              <input
                type="checkbox"
                data-testid={`option-${option.key}`}
                className="mt-1 accent-accent"
                checked={option.checked && option.supported}
                disabled={!option.supported}
                onChange={(e) => {
                  saveOption(option.key, e.target.checked);
                  c.set({ [option.key]: e.target.checked });
                  checkConditions().catch(() => {});
                }}
              />
              <span>
                {option.label}
                {!option.supported && <span className="block text-xs text-fg-3">{option.missing}</span>}
              </span>
            </label>
          ))}
        </div>
        <button
          onClick={() => deleteStoredData()}
          disabled={c.sharing || c.chunksStored === 0}
          className="mt-3 border border-fg px-3 py-1 text-xs hover:bg-fg hover:text-ink disabled:border-line disabled:text-fg-3 disabled:hover:bg-transparent"
        >
          Delete stored data
        </button>
      </section>
    </div>
  );
}

