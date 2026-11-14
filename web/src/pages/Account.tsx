import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { homeOf, roleOf } from '../lib/role';
import { endSession } from '../lib/session';
import type { User } from '../lib/types';
import { stopSharing } from '../p2p/contributor';
import { useAuth } from '../store/auth';
import { saveOption } from '../store/contributor';
import { usePlan } from '../store/plan';

/** Accounts made from the start screen live on this phone only. */
const isPhoneAccount = (user: User) => user.email.endsWith('@peerbeats.invalid');

export function Account() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const token = useAuth((s) => s.token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user || !token) return null;
  const role = roleOf(user);

  async function switchRole() {
    setBusy(true);
    setError(null);
    try {
      const becomeContributor = role === 'listener';
      // A contributor listens too, so the music keeps playing. A listener doesn't share, so sharing stops.
      if (!becomeContributor) stopSharing();
      // Sharing follows the role: on for a new contributor, off for a listener.
      saveOption('keepSharing', becomeContributor);
      const res = await api<{ user: User }>('/api/me/contributor', { method: 'POST', body: { enabled: becomeContributor } });
      useAuth.getState().setSession(token!, res.user);
      usePlan.getState().load().catch(() => {});
      navigate(becomeContributor ? '/share' : homeOf('listener'), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work.');
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    if (isPhoneAccount(user!) && !window.confirm('This account lives only on this phone. After signing out you can’t get back into it. Sign out?')) return;
    saveOption('keepSharing', false);
    endSession();
  }

  return (
    <div className="max-w-xl p-4 sm:p-6">
      <h1 className="border-b border-fg pb-2 text-lg">Account</h1>
      <table className="mt-3 w-full text-sm">
        <tbody>
          <tr className="border-b border-line">
            <td className="py-2 text-fg-2">Name</td>
            <td className="py-2 text-right" data-testid="account-name">{user.displayName}</td>
          </tr>
          <tr className="border-b border-line">
            <td className="py-2 text-fg-2">Using PeerBeats as</td>
            <td className="py-2 text-right font-semibold capitalize" data-testid="account-role">{role}</td>
          </tr>
          <tr className="border-b border-line">
            <td className="py-2 text-fg-2">Sign-in</td>
            <td className="py-2 text-right">{isPhoneAccount(user) ? 'This phone' : user.email}</td>
          </tr>
        </tbody>
      </table>

      {role !== 'admin' && (
        <button
          onClick={switchRole}
          disabled={busy}
          data-testid="switch-role"
          className="mt-5 w-full border border-fg py-2 text-sm font-semibold hover:bg-fg hover:text-ink disabled:opacity-60"
        >
          {role === 'listener' ? 'Switch to contributor' : 'Switch to listener'}
        </button>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}

      <button onClick={signOut} className="mt-3 w-full py-2 text-sm text-fg-2 underline underline-offset-2 hover:text-fg">
        Sign out
      </button>
    </div>
  );
}
