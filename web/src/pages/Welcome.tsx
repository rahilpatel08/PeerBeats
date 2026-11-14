import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useLabLinks } from '../lib/demoMode';
import { isInApp, isInstalled, isIos } from '../lib/install';
import type { User } from '../lib/types';
import { useAuth } from '../store/auth';
import { saveOption } from '../store/contributor';

type Choice = 'listener' | 'contributor';

const CHOICES: { role: Choice; title: string; detail: string }[] = [
  { role: 'listener', title: 'Listener', detail: 'Play music. Needs a plan.' },
  { role: 'contributor', title: 'Contributor', detail: 'Share this phone’s storage and connection, earn for what you deliver, and listen too.' },
];

/** The first screen on a new phone: pick how to use PeerBeats, give a name, and start. */
export function Welcome() {
  const navigate = useNavigate();
  const labLinks = useLabLinks();
  const [role, setRole] = useState<Choice | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(e: FormEvent) {
    e.preventDefault();
    if (!role) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; user: User }>('/api/auth/phone', { method: 'POST', body: { displayName: name, role } });
      // A new contributor wants sharing on. Saved first, so the Sharing page starts it however it's reached.
      saveOption('keepSharing', role === 'contributor');
      navigate(role === 'contributor' ? '/share' : '/subscribe', { replace: true });
      useAuth.getState().setSession(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again.');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={start} className="w-full max-w-md" data-testid="welcome">
        <h1 className="text-2xl">PeerBeats</h1>
        <p className="mt-1 text-sm text-fg-2">Music streamed from phones nearby.</p>

        <fieldset className="mt-8">
          <legend className="text-sm font-semibold">Use PeerBeats as</legend>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {CHOICES.map((choice) => (
              <button
                key={choice.role}
                type="button"
                aria-pressed={role === choice.role}
                data-testid={`role-${choice.role}`}
                onClick={() => setRole(choice.role)}
                className={`flex flex-col items-start gap-1 border p-3 text-left ${
                  role === choice.role ? 'border-2 border-fg bg-ink-3' : 'border-line hover:border-fg'
                }`}
              >
                <span className="text-base font-semibold">{choice.title}</span>
                <span className="text-xs text-fg-2">{choice.detail}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {role && (
          <div className="mt-6">
            <label htmlFor="your-name" className="text-sm font-semibold">Your name</label>
            <input
              id="your-name"
              data-testid="your-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoComplete="nickname"
              required
              className="mt-1 w-full border border-line bg-ink-2 px-3 py-2 text-base outline-none focus:border-fg"
            />
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="mt-3 w-full bg-fg py-2.5 text-sm font-semibold text-ink disabled:opacity-50"
            >
              {busy ? 'Starting' : `Continue as ${role}`}
            </button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}

        {/* Only worth doing on an address that lasts. A temporary link's icon would stop working. */}
        {isIos() && !isInstalled() && !isInApp() && !/\.trycloudflare\.com$/.test(window.location.hostname) && (
          <p className="mt-6 text-xs text-fg-2" data-testid="home-screen-tip">
            To keep PeerBeats as an app, add it to the Home Screen before you start: in Safari’s menu tap Share, View More, then Add to Home Screen. An account started here in Safari stays in Safari.
          </p>
        )}

        <p className="mt-8 border-t border-line pt-3 text-sm text-fg-2">
          Have an account with an email? <Link to="/login" className="text-fg underline underline-offset-2">Log in</Link>
          {labLinks && (
            <>
              {' / '}
              <Link to="/lab" className="text-accent underline underline-offset-2">Lab</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
