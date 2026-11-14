import { formatTime } from '../lib/format';
import type { Track } from '../lib/types';
import { playQueue } from '../player/engine';
import { usePlayer } from '../store/player';
import { Equalizer, Icon } from './Icon';
import { TrackActions } from './TrackActions';

// One template for the header and every row, so the columns line up.
const COLUMNS =
  'grid grid-cols-[2rem_minmax(0,1fr)_3.5rem] items-baseline gap-x-3 sm:grid-cols-[2rem_minmax(0,2fr)_minmax(0,1.4fr)_6rem_3.5rem_3.5rem]';

function TrackHeader({ removable }: { removable: boolean }) {
  return (
    <div className="flex border-b border-fg text-xs text-fg-3" aria-hidden="true">
      <div className={`${COLUMNS} min-w-0 flex-1 px-1 py-1`}>
        <span className="text-right">#</span>
        <span>Title</span>
        <span className="hidden sm:block">Artist</span>
        <span className="hidden sm:block">Genre</span>
        <span className="hidden text-right sm:block">Plays</span>
        <span className="text-right">Time</span>
      </div>
      <span className={removable ? 'w-[6.75rem]' : 'w-[4.5rem]'} />
    </div>
  );
}

export function TrackRow({
  track,
  position,
  onPlay,
  active,
  animate,
  onRemove,
}: {
  track: Track;
  position: number;
  onPlay: () => void;
  active: boolean;
  animate: boolean;
  onRemove?: () => void;
}) {
  return (
    <li className="flex items-center border-b border-line hover:bg-ink-3 focus-within:bg-ink-3">
      <button onClick={onPlay} className={`${COLUMNS} min-w-0 flex-1 px-1 py-1.5 text-left text-sm`}>
        <span className="flex justify-end font-mono text-xs text-fg-3">{active ? <Equalizer animate={animate} /> : position}</span>
        <span className={`truncate ${active ? 'font-semibold text-accent' : ''}`}>{track.title}</span>
        <span className="hidden truncate text-fg-2 sm:block">{track.artist}</span>
        <span className="hidden truncate text-fg-2 sm:block">{track.genre ?? ''}</span>
        <span className="hidden text-right font-mono text-xs text-fg-2 sm:block">{track.playCount}</span>
        <span className="text-right font-mono text-xs text-fg-2">{formatTime(track.durationSec)}</span>
      </button>
      <TrackActions track={track} />
      {onRemove && (
        <button onClick={onRemove} aria-label={`Remove ${track.title} from this playlist`} className="flex h-9 w-9 shrink-0 items-center justify-center text-fg-3 hover:text-danger">
          <Icon name="close" size={16} />
        </button>
      )}
    </li>
  );
}

export function TrackList({ tracks, onRemove }: { tracks: Track[]; onRemove?: (track: Track) => void }) {
  const currentId = usePlayer((s) => s.current?.id);
  const status = usePlayer((s) => s.status);
  return (
    <div>
      <TrackHeader removable={Boolean(onRemove)} />
      <ul>
        {tracks.map((track, i) => (
          <TrackRow
            key={track.id}
            track={track}
            position={i + 1}
            active={track.id === currentId}
            animate={status === 'playing'}
            onPlay={() => playQueue(tracks, i)}
            onRemove={onRemove ? () => onRemove(track) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

export function TrackListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-px" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-8" />
      ))}
    </div>
  );
}
