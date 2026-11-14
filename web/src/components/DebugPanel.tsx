import { formatBytes } from '../lib/format';
import type { ChunkEvent } from '../lib/types';
import { usePlayer } from '../store/player';
import { Icon } from './Icon';

const RESULT_LABEL: Record<ChunkEvent['result'], { text: string; className: string }> = {
  ok: { text: 'Hash OK', className: 'text-accent' },
  cached: { text: 'Hash OK, pre-fetched', className: 'text-accent' },
  'hash-mismatch': { text: 'HASH MISMATCH', className: 'font-semibold text-danger' },
  timeout: { text: 'No answer in time', className: 'text-warn' },
  miss: { text: 'Doesn\u2019t have it', className: 'text-warn' },
  'peer-left': { text: 'Contributor left', className: 'text-warn' },
};

export function DebugPanel() {
  const open = usePlayer((s) => s.debugOpen);
  const log = usePlayer((s) => s.log);
  const stats = usePlayer((s) => s.stats);
  const set = usePlayer((s) => s.set);
  if (!open) return null;

  return (
    <aside
      aria-label="Debug panel"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-line bg-ink-2"
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Segment log</h2>
        <button onClick={() => set({ debugOpen: false })} aria-label="Close debug panel" className="rounded p-1 text-fg-2 hover:text-fg">
          <Icon name="close" />
        </button>
      </header>

      <dl className="grid grid-cols-4 gap-px border-b border-line bg-line text-center">
        {[
          ['Segments', stats.segments],
          ['Data', formatBytes(stats.bytes)],
          ['Bad hashes', stats.hashFailures],
          ['Repaired', stats.recovered],
        ].map(([label, value]) => (
          <div key={label} className="bg-ink-2 px-1 py-2.5">
            <dd data-testid={`stat-${label}`} className="font-mono text-sm tabular-nums">{value}</dd>
            <dt className="text-[11px] text-fg-3">{label}</dt>
          </div>
        ))}
      </dl>

      <div className="flex-1 overflow-y-auto">
        {log.length === 0 ? (
          <p className="p-4 text-sm text-fg-3">Play a track to see each segment arrive.</p>
        ) : (
          <table className="w-full text-left font-mono text-xs">
            <thead className="sticky top-0 bg-ink-2 text-[11px] text-fg-3">
              <tr>
                <th className="px-3 py-2 font-normal">Seg</th>
                <th className="px-2 py-2 font-normal">Source</th>
                <th className="px-2 py-2 text-right font-normal">ms</th>
                <th className="px-2 py-2 text-right font-normal">Size</th>
                <th className="px-3 py-2 font-normal">Check</th>
              </tr>
            </thead>
            <tbody>
              {log.map((e) => (
                <tr key={e.id} data-testid="chunk-row" className={`border-t border-line/60 ${e.result === 'hash-mismatch' ? 'bg-danger/10' : ''}`}>
                  <td className="px-3 py-1.5 tabular-nums">{e.idx === 0 ? 'init' : e.idx}</td>
                  <td className={`max-w-[9rem] truncate px-2 py-1.5 ${e.peerId ? 'text-accent' : ''}`}>
                    {e.source}
                    {e.via === 'relay' && <span data-testid="via-relay" className="text-fg-3"> (relayed)</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-fg-2">{e.latencyMs}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-fg-2">{formatBytes(e.bytes)}</td>
                  <td className={`px-3 py-1.5 ${RESULT_LABEL[e.result].className}`}>{RESULT_LABEL[e.result].text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}
