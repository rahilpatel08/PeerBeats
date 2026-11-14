import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { TrackList, TrackListSkeleton } from '../components/TrackList';
import { api } from '../lib/api';
import type { Track } from '../lib/types';

export function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    const timer = window.setTimeout(async () => {
      try {
        const q = query.trim();
        const { tracks } = await api<{ tracks: Track[] }>(`/api/tracks${q ? `?query=${encodeURIComponent(q)}` : ''}`);
        if (request === latest.current) {
          setResults(tracks);
          setError(null);
        }
      } catch (err) {
        if (request === latest.current) setError(err instanceof Error ? err.message : 'Search failed.');
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [query]);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <h1 className="text-lg">Search</h1>
      <div className="relative mt-4">
        <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
        <input
          type="search"
          autoFocus
          aria-label="Search tracks, artists and genres"
          placeholder="Tracks, artists, genres"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-line bg-ink-2 py-2.5 pl-10 pr-3 text-sm outline-none transition placeholder:text-fg-3 focus:border-accent"
        />
      </div>
      <div className="mt-4">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!results && !error && <TrackListSkeleton />}
        {results && results.length === 0 && (
          <p className="py-8 text-center text-sm text-fg-2">Nothing matches "{query.trim()}".</p>
        )}
        {results && results.length > 0 && <TrackList tracks={results} />}
      </div>
    </div>
  );
}
