import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/Layout';
import { api } from '../lib/api';
import { useLabLinks } from '../lib/demoMode';
import type { User } from '../lib/types';
import { useAuth } from '../store/auth';

const DEMO_ACCOUNTS = [
  { label: 'Listener 1', email: 'listener@peerbeats.test' },
  { label: 'Contributor A', email: 'contributor.a@peerbeats.test' },
  { label: 'New listener', email: 'new.listener@peerbeats.test' },
  { label: 'Admin', email: 'admin@peerbeats.test' },
];
const DEMO_PASSWORD = 'demo1234';

interface AuthResponse {
  token: string;
  user: User;
}

export function Login() {
  const setSession = useAuth((s) => s.setSession);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The demo accounts are for the laptop running the Lab. Phones start from the role screen.
  const labLinks = useLabLinks();

  async function login(body: { email: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<AuthResponse>('/api/auth/login', { method: 'POST', body });
      setSession(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log in.');
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'login') return login({ email, password });
    setBusy(true);
    setError(null);
    try {
      const res = await api<AuthResponse>('/api/auth/signup', { method: 'POST', body: { email, password, displayName } });
      setSession(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your account.');
      setBusy(false);
    }
  }

  const field = 'w-full rounded-lg border border-line bg-ink-2 px-3 py-2.5 text-sm outline-none transition placeholder:text-fg-3 focus:border-accent';

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <Logo />
        <h1 className="mt-6 text-lg">
          {mode === 'login' ? 'Log in' : 'Sign up'}
        </h1>

        <form onSubmit={submit} className="mt-6 space-y-3">
          {mode === 'signup' && (
            <div>
              <label htmlFor="name" className="mb-1 block text-xs text-fg-2">Display name</label>
              <input id="name" className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" required />
            </div>
          )}
          <div>
            <label htmlFor="email" className="mb-1 block text-xs text-fg-2">Email</label>
            <input id="email" type="email" className={field} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs text-fg-2">Password</label>
            <input
              id="password"
              type="password"
              className={field}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'signup' ? 8 : undefined}
              required
            />
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 text-sm font-semibold disabled:opacity-60 border border-fg hover:bg-fg hover:text-ink"
          >
            {busy ? 'Please wait' : mode === 'login' ? 'Log in' : 'Sign up'}
          </button>
        </form>

        <button
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login');
            setError(null);
          }}
          className="mt-3 text-sm text-fg-2 underline-offset-2 hover:text-fg hover:underline"
        >
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}
        </button>

        <Link to="/" className="mt-3 block text-sm text-fg-2 underline-offset-2 hover:text-fg hover:underline">
          Back to the start screen
        </Link>

        {labLinks && (
          <section className="mt-8 border-t border-line pt-4">
            <Link to="/lab" className="mb-3 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline">
              Back to Lab
            </Link>
            <h2 className="text-xs text-fg-3">Demo accounts</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  disabled={busy}
                  onClick={() => login({ email: account.email, password: DEMO_PASSWORD })}
                  className="rounded-full border border-line px-3 py-1.5 text-xs text-fg-2 transition hover:border-accent hover:text-fg disabled:opacity-60"
                >
                  {account.label}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
