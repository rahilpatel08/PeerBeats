import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, authHeaders } from '../lib/api';
import { formatTime } from '../lib/format';
import type { Track } from '../lib/types';
import { useAuth } from '../store/auth';

interface Job {
  id: string;
  title: string;
  artist: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  error?: string;
  segments?: number;
  durationSec?: number;
}

const STATUS = {
  queued: { text: 'Waiting', className: 'text-fg-3' },
  processing: { text: 'Encrypting and splitting', className: 'text-warn' },
  done: { text: 'Added. Sent to contributors.', className: 'text-accent' },
  failed: { text: 'Failed', className: 'text-danger' },
};

export function Catalog() {
  const user = useAuth((s) => s.user);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [licenses, setLicenses] = useState<string[]>([]);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [genre, setGenre] = useState('');
  const [license, setLicense] = useState('');
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [ingest, catalog] = await Promise.all([
      api<{ jobs: Job[]; licenses: string[] }>('/api/admin/ingest'),
      api<{ tracks: Track[] }>('/api/tracks'),
    ]);
    setJobs(ingest.jobs);
    setLicenses(ingest.licenses);
    setTracks(catalog.tracks);
  }, []);

  useEffect(() => {
    if (!user?.isAdmin) return;
    refresh().catch((err) => setError(err.message));
    const timer = window.setInterval(() => refresh().catch(() => {}), 2000);
    return () => window.clearInterval(timer);
  }, [refresh, user?.isAdmin]);

  if (!user?.isAdmin) {
    return <p className="p-6 text-fg-2">The catalog is for the admin account. Open it from the Lab page.</p>;
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    const chosen = file.current?.files?.[0];
    if (!chosen) return setError('Choose an audio file.');
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ title, artist, license, ...(genre.trim() ? { genre } : {}) });
      const res = await fetch(`/api/admin/tracks?${query}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
        body: chosen,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'The upload failed.');
      setTitle('');
      setArtist('');
      setGenre('');
      setLicense('');
      setRights(false);
      if (file.current) file.current.value = '';
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload failed.');
    } finally {
      setBusy(false);
    }
  }

  const field = 'mt-1 w-full rounded-lg border border-line bg-ink-3 px-3 py-2 text-sm outline-none transition placeholder:text-fg-3 focus:border-accent';

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <h1 className="text-lg">Catalog</h1>

      <form onSubmit={upload} className="mt-4 border-t border-fg pt-2" aria-labelledby="upload-heading">
        <h2 id="upload-heading" className="text-sm font-semibold">Add a track</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-fg-2">Title
            <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
          </label>
          <label className="text-xs text-fg-2">Artist
            <input className={field} value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={120} required />
          </label>
          <label className="text-xs text-fg-2">Genre, optional
            <input className={field} value={genre} onChange={(e) => setGenre(e.target.value)} maxLength={40} />
          </label>
          <label className="text-xs text-fg-2">License
            <select className={field} value={license} onChange={(e) => setLicense(e.target.value)} required>
              <option value="">Choose one</option>
              {licenses.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs text-fg-2 sm:col-span-2">Audio file: MP3, WAV, FLAC, OGG or M4A, up to 50 MB
            <input ref={file} data-testid="upload-file" type="file" accept=".mp3,.wav,.flac,.ogg,.m4a,audio/*" className={`${field} file:mr-3 file:rounded file:border-0 file:bg-ink-4 file:px-2 file:py-1 file:text-xs file:text-fg`} required />
          </label>
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm text-fg-2">
          <input type="checkbox" className="mt-1 accent-accent" checked={rights} onChange={(e) => setRights(e.target.checked)} required />
          I own this music, or its license allows it to be shared and streamed here.
        </label>
        {error && <p role="alert" data-testid="upload-error" className="mt-3 text-sm text-danger">{error}</p>}
        <button type="submit" disabled={busy} className="mt-3 px-4 py-2 text-sm font-semibold disabled:opacity-60 border border-fg hover:bg-fg hover:text-ink">
          {busy ? 'Uploading' : 'Upload'}
        </button>
      </form>

      {jobs.length > 0 && (
        <section className="mt-4 border-t border-fg pt-2" aria-labelledby="jobs-heading">
          <h2 id="jobs-heading" className="text-sm font-semibold">Recent uploads</h2>
          <ul className="mt-2 space-y-1.5 text-sm" data-testid="ingest-jobs">
            {jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 truncate">{job.title} <span className="text-fg-3">by {job.artist}</span></span>
                <span data-testid="job-status" className={`text-xs ${STATUS[job.status].className}`}>
                  {job.error ?? STATUS[job.status].text}
                  {job.status === 'done' && ` ${job.segments} segments, ${formatTime(job.durationSec ?? 0)}.`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-4 border-t border-fg pt-2" aria-labelledby="tracks-heading">
        <h2 id="tracks-heading" className="text-sm font-semibold">All tracks{tracks ? `, ${tracks.length}` : ''}</h2>
        {!tracks ? (
          <div className="skeleton mt-2 h-32 rounded-lg" />
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-fg-3">
                <tr>
                  <th className="py-1 pr-3 font-normal">Title</th>
                  <th className="py-1 pr-3 font-normal">Artist</th>
                  <th className="py-1 pr-3 font-normal">License</th>
                  <th className="py-1 text-right font-normal">Length</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => (
                  <tr key={t.id} className="border-t border-line/60">
                    <td className="py-1.5 pr-3">{t.title}</td>
                    <td className="py-1.5 pr-3 text-fg-2">{t.artist}</td>
                    <td className="py-1.5 pr-3 text-fg-2">{t.license}</td>
                    <td className="py-1.5 text-right font-mono text-xs tabular-nums text-fg-3">{formatTime(t.durationSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
