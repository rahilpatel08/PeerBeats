import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { api } from './lib/api';
import { useServerInfo } from './lib/demoMode';
import type { User } from './lib/types';
import { Account } from './pages/Account';
import { Catalog } from './pages/Catalog';
import { Home } from './pages/Home';
import { Lab } from './pages/Lab';
import { Library, PlaylistPage } from './pages/Library';
import { Login } from './pages/Login';
import { Monitor } from './pages/Monitor';
import { NowPlaying } from './pages/NowPlaying';
import { Search } from './pages/Search';
import { Share } from './pages/Share';
import { Subscribe } from './pages/Subscribe';
import { Welcome } from './pages/Welcome';
import { togglePlay } from './player/engine';
import { useAuth } from './store/auth';
import { useLibrary } from './store/library';
import { usePlan } from './store/plan';

/** The Lab only exists in demo mode, and only on the laptop running the server. Phones get the app. */
function LabGate() {
  const info = useServerInfo();
  if (info === null) return null;
  return info.demoMode && info.local ? <Lab /> : <Navigate to="/" replace />;
}

/**
 * Hashing and decryption only work on a secure address, which the phone link is. Anyone who
 * reaches PeerBeats some other way is pointed to it.
 */
function NeedsSecureAddress() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/join')
      .then((res) => res.json())
      .then((data) => setUrl(typeof data?.link?.url === 'string' ? data.link.url : null))
      .catch(() => {});
  }, []);
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md" data-testid="needs-secure-address">
        <h1 className="text-2xl">PeerBeats</h1>
        <p className="mt-3 text-sm text-fg-2">This address isn’t secure, so music can’t be checked or unlocked here.</p>
        {url ? (
          <a href={url} className="mt-4 block w-full bg-fg py-2.5 text-center text-sm font-semibold text-ink">Open PeerBeats</a>
        ) : (
          <p className="mt-3 text-sm text-fg-2">Open the PeerBeats link instead: scan the code in the PeerBeats app on the Mac, or ask for the link.</p>
        )}
      </div>
    </div>
  );
}

export function App() {
  return window.isSecureContext ? <SecureApp /> : <NeedsSecureAddress />;
}

function SecureApp() {
  const token = useAuth((s) => s.token);
  const isContributor = useAuth((s) => s.user?.isContributor);

  useEffect(() => {
    if (token) useLibrary.getState().load();
    else useLibrary.getState().clear();
  }, [token]);

  // A listener without a plan is sent to Plan, so know the plan before deciding.
  useEffect(() => {
    if (token) usePlan.getState().load().catch(() => {});
    else usePlan.getState().clear();
  }, [token, isContributor]);

  // A stored token can be out of date, so check it once at startup. A 401 logs out.
  useEffect(() => {
    if (!token) return;
    api<{ user: User }>('/api/me')
      .then(({ user }) => useAuth.getState().setSession(token, user))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON' || el.isContentEditable;
      if (e.code === 'Space' && !typing) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="lab" element={<LabGate />} />
        {token ? (
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="search" element={<Search />} />
            <Route path="now" element={<NowPlaying />} />
            <Route path="share" element={<Share />} />
            <Route path="earnings" element={<Navigate to="/share" replace />} />
            <Route path="account" element={<Account />} />
            <Route path="subscribe" element={<Subscribe />} />
            <Route path="monitor" element={<Monitor />} />
            <Route path="library" element={<Library />} />
            <Route path="library/:id" element={<PlaylistPage />} />
            <Route path="catalog" element={<Catalog />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          <>
            <Route path="login" element={<Login />} />
            <Route path="*" element={<Welcome />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}
