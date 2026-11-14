import { usePlayer } from '../store/player';

/** Who is connected and delivering right now. Changes the moment a contributor leaves. */
export function DeliveredBy() {
  const connected = usePlayer((s) => s.connectedPeers);
  const checked = usePlayer((s) => s.peersChecked);
  const hashFailures = usePlayer((s) => s.stats.hashFailures);
  const set = usePlayer((s) => s.set);
  const none = checked && connected.length === 0;
  const label = !checked && connected.length === 0
    ? 'connecting'
    : none
      ? 'no contributors'
      : connected.length <= 2
        ? connected.join(' + ')
        : `${connected.length} contributors`;
  return (
    <button onClick={() => set({ debugOpen: true })} className="text-left text-xs text-fg-2 hover:text-fg">
      Delivered by:{' '}
      <span data-testid="delivered-by" className={`font-semibold ${none ? 'text-danger' : 'text-fg'}`}>{label}</span>
      {hashFailures > 0 && <span className="text-warn"> (repaired {hashFailures})</span>}
    </button>
  );
}

/** Explains silence plainly: contributors are the only source of music. */
export function PeerNotice() {
  const current = usePlayer((s) => s.current);
  const connected = usePlayer((s) => s.connectedPeers);
  const checked = usePlayer((s) => s.peersChecked);
  const waiting = usePlayer((s) => s.waitingForPeers);
  const status = usePlayer((s) => s.status);
  if (!current || !checked || status === 'error') return null;
  const stalled = status === 'loading' || status === 'buffering';

  let message: string | null = null;
  if (connected.length === 0) {
    message = stalled
      ? 'No contributors are online with this song, so it can’t play. It will start by itself when one comes back.'
      : 'All contributors have left. Only what’s already loaded will play, then the music stops until one comes back.';
  } else if (waiting && stalled) {
    message = 'The contributors online don’t have this part of the song yet. It will continue by itself when they do.';
  }
  if (!message) return null;
  return (
    <p role="status" data-testid="peer-notice" className="bg-warn/10 px-4 py-1 text-xs text-warn">
      {message}
    </p>
  );
}
