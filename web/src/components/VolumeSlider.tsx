import { setVolume } from '../player/engine';
import { usePlayer } from '../store/player';
import { Icon } from './Icon';

export function VolumeSlider() {
  const volume = usePlayer((s) => s.volume);
  return (
    <label className="flex items-center gap-2 text-fg-2">
      <Icon name="volume" />
      <input
        type="range"
        aria-label="Volume"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        className="h-1 w-24 accent-accent"
      />
    </label>
  );
}
