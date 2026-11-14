import { useState } from 'react';
import { formatTime } from '../lib/format';
import { seek } from '../player/engine';
import { usePlayer } from '../store/player';

export function SeekBar({ compact = false }: { compact?: boolean }) {
  const currentTime = usePlayer((s) => s.currentTime);
  const duration = usePlayer((s) => s.duration);
  const buffered = usePlayer((s) => s.buffered);
  const [dragging, setDragging] = useState<number | null>(null);

  const shown = dragging ?? currentTime;
  const max = duration || 1;
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;

  return (
    <div className="flex items-center gap-3">
      {!compact && <span className="w-10 text-right font-mono text-xs tabular-nums text-fg-2">{formatTime(shown)}</span>}
      <div className="relative h-5 flex-1">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-ink-4">
          {buffered.map(([start, end]) => (
            <div
              key={start}
              data-testid="buffered-range"
              className="absolute inset-y-0 bg-fg-3/60"
              style={{ left: pct(start), width: `${Math.min(100, ((end - start) / max) * 100)}%` }}
            />
          ))}
          <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: pct(shown) }} />
        </div>
        <input
          type="range"
          aria-label="Seek"
          aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
          min={0}
          max={max}
          step={0.1}
          value={Math.min(shown, max)}
          className="range-overlay absolute inset-0 h-full w-full"
          onChange={(e) => setDragging(Number(e.target.value))}
          onPointerUp={(e) => {
            seek(Number((e.target as HTMLInputElement).value));
            setDragging(null);
          }}
          onKeyUp={(e) => {
            if (dragging !== null) {
              seek(dragging);
              setDragging(null);
            }
            e.stopPropagation();
          }}
        />
      </div>
      {!compact && <span className="w-10 font-mono text-xs tabular-nums text-fg-2">{formatTime(duration)}</span>}
    </div>
  );
}
