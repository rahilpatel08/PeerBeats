import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { TrackList, TrackListSkeleton } from '../components/TrackList';
import { api } from '../lib/api';
import type { Track } from '../lib/types';
import { playQueue } from '../player/engine';
import { useLibrary } from '../store/library';

export function Library() {
  const likedIds = useLibrary((s) => s.likedIds);
  const playlists = useLibrary((s) => s.playlists);
  const loaded = useLibrary((s) => s.loaded);
  const loadError = useLibrary((s) => s.error);
  const [liked, setLiked] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  // Stays in step when a song is unliked from this page or anywhere else.
  useEffect(() => {
    api<{ tracks: Track[] }>('/api/likes')
      .then((res) => {
        setLiked(res.tracks);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [likedIds]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    try {
      await useLibrary.getState().createPlaylist(name);
      setName('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create that playlist.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <h1 className="text-lg">Library</h1>

      <section className="mt-5" aria-labelledby="playlists-heading">
        <h2 id="playlists-heading" className="text-sm font-semibold">Playlists</h2>
        {(loadError || !loaded) && (loadError ? <p role="alert" className="mt-2 text-sm text-danger">{loadError}</p> : <div className="skeleton mt-2 h-16 rounded-xl" />)}
        {loaded && !loadError && (
          <ul className="mt-1 border-t border-fg" data-testid="playlist-list">
            {playlists.map((p) => (
              <li key={p.id}>
                <Link to={`/library/${p.id}`} className="flex justify-between gap-3 border-b border-line py-1.5 text-sm hover:bg-ink-3">
                  <span className="truncate text-accent underline underline-offset-2">{p.name}</span>
                  <span className="shrink-0 font-mono text-xs text-fg-3">{p.trackCount} {p.trackCount === 1 ? 'song' : 'songs'}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={create} className="mt-3 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            aria-label="New playlist name"
            placeholder="New playlist name"
            className="min-w-0 flex-1 rounded-lg border border-line bg-ink-2 px-3 py-2 text-sm outline-none placeholder:text-fg-3 focus:border-accent"
          />
          <button type="submit" className="px-4 py-2 text-sm font-semibold border border-fg hover:bg-fg hover:text-ink">Create</button>
        </form>
        {createError && <p role="alert" className="mt-2 text-sm text-danger">{createError}</p>}
      </section>

      <section className="mt-7" aria-labelledby="liked-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="liked-heading" className="text-sm font-semibold">Liked songs</h2>
          {liked && liked.length > 0 && (
            <button onClick={() => playQueue(liked, 0)} className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold border border-fg hover:bg-fg hover:text-ink">
              <Icon name="play" size={14} /> Play all
            </button>
          )}
        </div>
        <div className="mt-2" data-testid="liked-list">
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {!liked && !error && <TrackListSkeleton rows={3} />}
          {liked && liked.length === 0 && <p className="py-4 text-sm text-fg-3">Press the heart on any song to keep it here.</p>}
          {liked && liked.length > 0 && <TrackList tracks={liked} />}
        </div>
      </section>
    </div>
  );
}

export function PlaylistPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [playlist, setPlaylist] = useState<{ id: string; name: string; tracks: Track[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ playlist: { id: string; name: string; tracks: Track[] } }>(`/api/playlists/${id}`)
      .then((res) => {
        setPlaylist(res.playlist);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [id]);
  useEffect(load, [load]);

  async function remove(track: Track) {
    try {
      await useLibrary.getState().removeFromPlaylist(id!, track.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that song.');
    }
  }

  async function destroy() {
    try {
      await useLibrary.getState().deletePlaylist(id!);
      navigate('/library', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this playlist.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <Link to="/library" className="mb-3 inline-flex items-center gap-1 text-sm text-fg-2 hover:text-fg">
        <Icon name="chevron" className="rotate-90" /> Library
      </Link>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {!playlist && !error && <TrackListSkeleton rows={4} />}
      {playlist && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="min-w-0 truncate text-lg">{playlist.name}</h1>
            <div className="flex items-center gap-2">
              {playlist.tracks.length > 0 && (
                <button onClick={() => playQueue(playlist.tracks, 0)} className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold border border-fg hover:bg-fg hover:text-ink">
                  <Icon name="play" size={16} /> Play
                </button>
              )}
              <button onClick={destroy} className="rounded-full border border-line px-3 py-1.5 text-xs text-fg-2 transition hover:border-danger hover:text-danger">
                Delete playlist
              </button>
            </div>
          </div>
          <div className="mt-4">
            {playlist.tracks.length === 0 ? (
              <p className="py-6 text-center text-sm text-fg-3">
                Empty so far. Press the plus on any song in <Link to="/search" className="underline underline-offset-2">Search</Link> to add it.
              </p>
            ) : (
              <TrackList tracks={playlist.tracks} onRemove={remove} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
