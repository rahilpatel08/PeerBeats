import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { TransportControls } from '../components/Controls';
import { Cover } from '../components/Cover';
import { DeliveredBy, PeerNotice } from '../components/DeliveredBy';
import { Equalizer } from '../components/Icon';
import { SeekBar } from '../components/SeekBar';
import { TrackActions } from '../components/TrackActions';
import { VolumeSlider } from '../components/VolumeSlider';
import { formatNumber, formatTime } from '../lib/format';
import { playFromQueue } from '../player/engine';
import { usePlayer } from '../store/player';

export function NowPlaying() {
  const current = usePlayer((s) => s.current);
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const status = usePlayer((s) => s.status);
  const error = usePlayer((s) => s.error);
  const needsPayment = usePlayer((s) => s.needsPayment);
  const buffered = usePlayer((s) => s.buffered);
  const stats = usePlayer((s) => s.stats);

  if (!current) {
    return (
      <div className="p-6 text-sm">
        Nothing is playing. <Link to="/" className="text-accent underline">Tracks</Link>
      </div>
    );
  }

  const details: [string, ReactNode][] = [
    ['Album', current.album ?? 'none'],
    ['Genre', current.genre ?? 'none'],
    ['License', current.license],
    ['Length', formatTime(current.durationSec)],
    ['Segments', `${current.segmentCount} of 5 s, plus 1 header`],
    ['Track id', current.id],
    ['Status', status],
    ['Buffered', buffered.length ? buffered.map(([a, b]) => `${a.toFixed(1)} to ${b.toFixed(1)} s`).join(', ') : 'nothing'],
    ['Segments received', stats.segments],
    ['Bytes received', formatNumber(stats.bytes)],
    ['Failed hash checks', stats.hashFailures],
    ['Replaced after a failed check', stats.recovered],
  ];

  return (
    <div className="p-4 sm:p-6">
      <Link to="/" className="text-sm text-accent underline underline-offset-2">Tracks</Link>
      <div className="mt-3 flex flex-col gap-8 lg:flex-row">
        <section className="min-w-0 flex-1">
          <div className="flex items-start gap-4">
            <Cover url={current.coverUrl} title={current.title} className="h-24 w-24 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <h1 className="min-w-0 flex-1 truncate text-lg">{current.title}</h1>
                <TrackActions track={current} />
              </div>
              <p className="text-sm text-fg-2">{current.artist}</p>
              <div className="mt-1">
                <DeliveredBy />
              </div>
            </div>
          </div>
          <div className="mt-3 empty:hidden">
            <PeerNotice />
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}{' '}
              {needsPayment ? <Link to="/subscribe" className="font-semibold underline underline-offset-2">See plans</Link> : 'Press play to try again.'}
            </p>
          )}
          <div className="mt-4">
            <SeekBar />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <TransportControls size={40} />
            <VolumeSlider />
          </div>
          <table className="mt-5 w-full text-sm">
            <tbody>
              {details.map(([label, value]) => (
                <tr key={label} className="border-b border-line">
                  <th scope="row" className="w-48 py-1 pr-4 text-left font-normal text-fg-2">{label}</th>
                  <td className="break-all py-1 font-mono text-xs">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="min-w-0 lg:w-80">
          <h2 className="border-b border-fg pb-1 text-sm font-semibold">Queue</h2>
          <ol>
            {queue.map((t, i) => (
              <li key={t.id} className="border-b border-line">
                <button
                  onClick={() => playFromQueue(i)}
                  aria-current={i === index}
                  className="flex w-full items-baseline gap-2 py-1 text-left text-sm hover:bg-ink-3"
                >
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-fg-3">{i === index ? <Equalizer animate={status === 'playing'} /> : i + 1}</span>
                  <span className={`min-w-0 flex-1 truncate ${i === index ? 'font-semibold text-accent' : ''}`}>{t.title}</span>
                  <span className="font-mono text-xs text-fg-3">{formatTime(t.durationSec)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
