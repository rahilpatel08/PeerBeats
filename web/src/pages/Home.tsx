import { useEffect, useMemo, useState } from 'react';
import { TrackList, TrackListSkeleton } from '../components/TrackList';
import { api } from '../lib/api';
import type { Track } from '../lib/types';

export function Home() {
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [genre, setGenre] = useState('');
  const [sort, setSort] = useState<'plays' | 'title' | 'length'>('plays');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    api<{ tracks: Track[] }>('/api/tracks')
      .then((res) => setTracks(res.tracks))
      .catch((err) => setError(err.message));
  }, [attempt]);

  const genres = useMemo(() => [...new Set((tracks ?? []).map((t) => t.genre).filter(Boolean))].sort() as string[], [tracks]);
  const shown = useMemo(() => {
    const list = (tracks ?? []).filter((t) => !genre || t.genre === genre);
    const order = {
      plays: (a: Track, b: Track) => b.playCount - a.playCount || a.title.localeCompare(b.title),
      title: (a: Track, b: Track) => a.title.localeCompare(b.title),
      length: (a: Track, b: Track) => b.durationSec - a.durationSec,
    };
    return [...list].sort(order[sort]);
  }, [tracks, genre, sort]);

  const select = 'border border-line bg-ink px-1 py-0.5 text-sm';

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg">
          Tracks <span className="font-mono text-sm font-normal text-fg-3">{tracks ? shown.length : ''}</span>
        </h1>
        <div className="flex flex-wrap gap-4 text-sm text-fg-2">
          <label>
            Genre{' '}
            <select className={select} value={genre} onChange={(e) => setGenre(e.target.value)}>
              <option value="">All</option>
              {genres.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label>
            Sort{' '}
            <select className={select} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="plays">Plays</option>
              <option value="title">Title</option>
              <option value="length">Length</option>
            </select>
          </label>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error} <button onClick={() => setAttempt(attempt + 1)} className="underline">Try again</button>
        </p>
      )}
      <div className="mt-3">{tracks ? <TrackList tracks={shown} /> : !error && <TrackListSkeleton />}</div>
    </div>
  );
}
