import { useEffect, useState } from 'react';
import { getSocket } from '../p2p/socket';

const GRACE_MS = 3000;

/** Says so when the device is offline or the server can't be reached, and when it's back. */
export function ConnectionBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [serverLost, setServerLost] = useState(false);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);

    const socket = getSocket();
    let timer: number | undefined;
    // A quick blip shouldn't flash a warning.
    const lost = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setServerLost(true), GRACE_MS);
    };
    const back = () => {
      window.clearTimeout(timer);
      setServerLost(false);
    };
    socket.on('disconnect', lost);
    socket.on('connect_error', lost);
    socket.on('connect', back);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      window.clearTimeout(timer);
      socket.off('disconnect', lost);
      socket.off('connect_error', lost);
      socket.off('connect', back);
    };
  }, []);

  if (!offline && !serverLost) return null;
  return (
    <p role="alert" data-testid="connection-banner" className="bg-danger/15 px-4 py-1.5 text-center text-xs text-danger">
      {offline ? 'You’re offline. PeerBeats needs a connection to find contributors.' : 'Can’t reach PeerBeats. Trying again…'}
    </p>
  );
}
