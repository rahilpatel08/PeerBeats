import { cycleRepeat, next, previous, toggleShuffle, togglePlay } from '../player/engine';
import { usePlayer } from '../store/player';
import { Icon } from './Icon';

export function PlayPauseButton({ size = 40 }: { size?: number }) {
  const status = usePlayer((s) => s.status);
  const busy = status === 'loading' || status === 'buffering';
  const playing = status === 'playing' || status === 'buffering';
  return (
    <button
      onClick={togglePlay}
      aria-label={playing ? 'Pause' : 'Play'}
      className="relative flex shrink-0 items-center justify-center rounded-full bg-fg text-ink hover:bg-fg-2"
      style={{ width: size, height: size }}
    >
      <Icon name={playing ? 'pause' : 'play'} size={size * 0.52} />
      {busy && <span className="absolute inset-[-3px] animate-spin rounded-full border-2 border-transparent border-t-accent" />}
    </button>
  );
}

export function TransportControls({ size = 40 }: { size?: number }) {
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const iconButton = 'flex h-10 w-10 items-center justify-center rounded-full text-fg-2 transition hover:text-fg';
  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3">
      <button
        onClick={toggleShuffle}
        aria-label="Shuffle"
        aria-pressed={shuffle}
        className={`${iconButton} ${shuffle ? '!text-accent' : ''}`}
      >
        <Icon name="shuffle" />
      </button>
      <button onClick={previous} aria-label="Previous track" className={iconButton}>
        <Icon name="prev" size={24} />
      </button>
      <PlayPauseButton size={size} />
      <button onClick={() => next()} aria-label="Next track" className={iconButton}>
        <Icon name="next" size={24} />
      </button>
      <button
        onClick={cycleRepeat}
        aria-label={`Repeat: ${repeat}`}
        className={`${iconButton} relative ${repeat !== 'off' ? '!text-accent' : ''}`}
      >
        <Icon name="repeat" />
        {repeat === 'one' && <span className="absolute right-1 top-1 text-[10px] font-bold">1</span>}
      </button>
    </div>
  );
}
