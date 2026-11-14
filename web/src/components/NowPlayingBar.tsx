import { Link } from 'react-router-dom';
import { usePlayer } from '../store/player';
import { PlayPauseButton, TransportControls } from './Controls';
import { DeliveredBy, PeerNotice } from './DeliveredBy';
import { SeekBar } from './SeekBar';
import { VolumeSlider } from './VolumeSlider';

export function NowPlayingBar() {
  const current = usePlayer((s) => s.current);
  const error = usePlayer((s) => s.error);
  const needsPayment = usePlayer((s) => s.needsPayment);
  const set = usePlayer((s) => s.set);
  const debugOpen = usePlayer((s) => s.debugOpen);
  if (!current) return null;

  return (
    <div className="border-t border-fg bg-ink">
      <PeerNotice />
      {error && (
        <p role="alert" data-testid="player-error" className="bg-danger/10 px-4 py-1 text-xs text-danger">
          {error}{' '}
          {needsPayment ? (
            <Link to="/subscribe" className="font-semibold underline underline-offset-2">See plans</Link>
          ) : (
            'Press play to try again.'
          )}
        </p>
      )}
      <div className="flex items-center gap-3 px-3 py-1.5 md:px-4">
        <Link to="/now" className="min-w-0 flex-1 md:w-56 md:flex-none">
          <span className="block min-w-0">
            <span className="block truncate text-sm font-semibold">{current.title}</span>
            <span className="block truncate text-xs text-fg-2">{current.artist}</span>
          </span>
        </Link>
        <div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">
          <TransportControls size={30} />
          <div className="min-w-0 flex-1">
            <SeekBar />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <div className="hidden xl:block">
            <DeliveredBy />
          </div>
          <div className="hidden lg:block">
            <VolumeSlider />
          </div>
          <button
            onClick={() => set({ debugOpen: !debugOpen })}
            aria-label="Toggle debug panel"
            aria-pressed={debugOpen}
            className="hidden text-xs text-accent underline underline-offset-2 md:block"
          >
            {debugOpen ? 'Hide log' : 'Segment log'}
          </button>
          <div className="md:hidden">
            <PlayPauseButton size={34} />
          </div>
        </div>
      </div>
      <div className="px-3 pb-1 md:hidden">
        <SeekBar compact />
      </div>
    </div>
  );
}
