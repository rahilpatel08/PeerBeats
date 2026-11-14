import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Track } from '../lib/types';
import { useLibrary } from '../store/library';
import { Icon } from './Icon';

export function TrackActions({ track }: { track: Track }) {
  const liked = useLibrary((s) => s.likedIds.has(track.id));
  const playlists = useLibrary((s) => s.playlists);
  const { toggleLike, addToPlaylist, createPlaylist } = useLibrary.getState();
  const [open, setOpen] = useState(false);
  const [upward, setUpward] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fail = (err: unknown) => setMessage(err instanceof Error ? err.message : 'That didn’t work.');

  async function add(playlistId: string) {
    setMessage(null);
    try {
      await addToPlaylist(playlistId, track.id);
      setOpen(false);
    } catch (err) {
      fail(err);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      const playlist = await createPlaylist(name);
      await addToPlaylist(playlist.id, track.id);
      setName('');
      setOpen(false);
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div ref={root} className="relative flex shrink-0 items-center">
      <button
        onClick={() => toggleLike(track.id).catch(() => {})}
        aria-label={liked ? `Remove ${track.title} from liked songs` : `Like ${track.title}`}
        aria-pressed={liked}
        className={`flex h-9 w-9 items-center justify-center rounded-full transition ${liked ? 'text-accent' : 'text-fg-3 hover:text-fg'}`}
      >
        <Icon name={liked ? 'heart' : 'heart-outline'} size={18} />
      </button>
      <button
        onClick={() => {
          const rect = root.current?.getBoundingClientRect();
          setUpward(Boolean(rect && rect.bottom > window.innerHeight / 2));
          setOpen(!open);
        }}
        aria-label={`Add ${track.title} to a playlist`}
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-full text-fg-3 transition hover:text-fg"
      >
        <Icon name="plus" size={18} />
      </button>
      {open && (
        <div className={`absolute right-0 z-30 w-60 border border-fg bg-ink p-2 ${upward ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          <p className="px-2 pb-1 text-xs text-fg-3">Add to playlist</p>
          <ul className="max-h-40 overflow-y-auto">
            {playlists.map((p) => {
              const already = p.trackIds.includes(track.id);
              return (
                <li key={p.id}>
                  <button
                    onClick={() => add(p.id)}
                    disabled={already}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-ink-4 disabled:opacity-50"
                  >
                    <span className="truncate">{p.name}</span>
                    {already && <Icon name="check" size={16} className="shrink-0 text-accent" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <form onSubmit={create} className="mt-1 flex gap-1 border-t border-line pt-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              aria-label="New playlist name"
              placeholder="New playlist"
              className="min-w-0 flex-1 rounded-lg border border-line bg-ink-2 px-2 py-1 text-sm outline-none placeholder:text-fg-3 focus:border-accent"
            />
            <button type="submit" className="px-2 text-xs font-semibold border border-fg hover:bg-fg hover:text-ink">Add</button>
          </form>
          {message && <p role="alert" className="mt-1 px-1 text-xs text-danger">{message}</p>}
        </div>
      )}
    </div>
  );
}
