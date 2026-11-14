import { useEffect, useState } from 'react';

interface ServerInfo {
  demoMode: boolean;
  /** True only on the computer running PeerBeats. Phones never see the Lab or its links. */
  local: boolean;
}

let known: ServerInfo | null = null;
let request: Promise<ServerInfo> | null = null;

function load() {
  request ??= fetch('/api/health')
    .then((res) => res.json())
    .then((health) => {
      known = { demoMode: Boolean(health.demoMode), local: Boolean(health.local) };
      return known;
    })
    .catch(() => {
      request = null;
      return { demoMode: false, local: false };
    });
  return request;
}

export function useServerInfo(): ServerInfo | null {
  const [info, setInfo] = useState(known);
  useEffect(() => {
    load().then(setInfo);
  }, []);
  return info;
}

/** Null until known. Lab-only controls stay hidden until the server confirms demo mode. */
export function useDemoMode(): boolean | null {
  const info = useServerInfo();
  return info ? info.demoMode : null;
}

/** The Lab and the demo accounts, which only make sense on the laptop running the server. */
export function useLabLinks(): boolean {
  const info = useServerInfo();
  return Boolean(info?.demoMode && info.local);
}
