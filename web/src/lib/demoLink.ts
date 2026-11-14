import { useAuth } from '../store/auth';
import { api } from './api';
import type { User } from './types';

const DEMO_PASSWORD = 'demo1234';
const ACCOUNTS: Record<string, string> = {
  listener: 'listener@peerbeats.test',
  listener2: 'listener2@peerbeats.test',
  listener3: 'listener3@peerbeats.test',
  listener4: 'listener4@peerbeats.test',
  listener5: 'listener5@peerbeats.test',
  'contributor.a': 'contributor.a@peerbeats.test',
  'contributor.b': 'contributor.b@peerbeats.test',
  'contributor.c': 'contributor.c@peerbeats.test',
  'contributor.d': 'contributor.d@peerbeats.test',
  'contributor.e': 'contributor.e@peerbeats.test',
  admin: 'admin@peerbeats.test',
  'new.listener': 'new.listener@peerbeats.test',
};

/** Builds a link that opens a page already logged in as a demo account. */
export const demoLink = (role: string, go: string) => `/?as=${encodeURIComponent(role)}&go=${encodeURIComponent(go)}`;

/** Handles those links on page load. The server refuses the password if demo mode is off. */
export async function applyDemoLink() {
  const params = new URLSearchParams(window.location.search);
  const email = ACCOUNTS[params.get('as') ?? ''];
  if (!email) return;
  const go = params.get('go') ?? '/';
  // Only ever a page on this site, so a crafted link can't send anyone elsewhere.
  const target = go.startsWith('/') && !go.startsWith('//') ? go : '/';
  try {
    const res = await api<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: { email, password: DEMO_PASSWORD },
    });
    useAuth.getState().setSession(res.token, res.user);
    window.history.replaceState(null, '', target);
  } catch {
    window.history.replaceState(null, '', '/');
  }
}
