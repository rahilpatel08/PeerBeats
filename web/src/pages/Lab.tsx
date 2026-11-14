import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { InstallCard } from '../components/InstallCard';
import { demoLink } from '../lib/demoLink';
import { markAsLabTab, openOrFocusTab } from '../lib/labTabs';
import { endSession } from '../lib/session';
import { useAuth } from '../store/auth';

type ListenerState = 'playing' | 'waiting' | 'paused';

interface LabStatus {
  local: boolean;
  network: {
    totalChunks: number;
    peers: { name: string; chunks: number }[];
    listeners: { name: string; trackTitle: string | null; state: ListenerState }[];
  };
  link: { state: 'off' | 'starting' | 'on' | 'error'; url: string | null; error: string | null; permanent: boolean };
  payments: { configured: boolean; portalActive: boolean };
}

interface Role {
  role: string;
  name: string;
  go: string;
  kind: 'contributor' | 'listener' | 'other';
  idle?: string;
}

const CONTRIBUTORS: Role[] = ['a', 'b', 'c', 'd', 'e'].map((letter) => ({
  role: `contributor.${letter}`,
  name: `Contributor ${letter.toUpperCase()}`,
  go: '/share?autostart=1',
  kind: 'contributor',
}));

const LISTENERS: Role[] = [
  ...['listener', 'listener2', 'listener3', 'listener4', 'listener5'].map((role, i): Role => ({
    role,
    name: `Listener ${i + 1}`,
    go: '/',
    kind: 'listener',
  })),
  { role: 'new.listener', name: 'New Listener', go: '/subscribe', kind: 'listener', idle: 'No plan' },
];

const ADMIN: Role = { role: 'admin', name: 'Monitor', go: '/monitor', kind: 'other', idle: 'Network and money' };

const labHeaders = { 'X-PeerBeats-Lab': '1', 'Content-Type': 'application/json' };

function statusOf(role: Role, status: LabStatus | null): { text: string; on: boolean } {
  if (role.kind === 'contributor') {
    const peer = status?.network.peers.find((p) => p.name === role.name);
    if (peer) return { text: `Sharing, ${peer.chunks} of ${status!.network.totalChunks}`, on: true };
    return { text: 'Off', on: false };
  }
  if (role.kind === 'listener') {
    const listener = status?.network.listeners.find((l) => l.name === role.name);
    if (!listener) return { text: role.idle ?? 'Not playing', on: false };
    const title = listener.trackTitle ?? 'a track';
    if (listener.state === 'playing') return { text: `Playing ${title}`, on: true };
    if (listener.state === 'paused') return { text: `Paused, ${title}`, on: false };
    return { text: `Waiting for a contributor, ${title}`, on: false };
  }
  return { text: role.idle ?? '', on: false };
}

function RoleList({ title, roles, status, onOpen }: { title: string; roles: Role[]; status: LabStatus | null; onOpen: (role: Role) => void }) {
  return (
    <section>
      <h2 className="border-b border-fg pb-1 font-semibold">{title}</h2>
      <ul>
        {roles.map((role) => {
          const live = statusOf(role, status);
          return (
            <li key={role.role} className="border-b border-line">
              <button onClick={() => onOpen(role)} className="flex w-full items-baseline justify-between gap-4 py-2 text-left hover:bg-ink-3">
                <span className="shrink-0 text-sm">{role.name}</span>
                <span className={`min-w-0 truncate text-xs ${live.on ? 'font-semibold text-accent' : 'text-fg-3'}`}>{live.text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The one way in for phones: a secure link that works on any network, anywhere. */
function PhoneLink({ status, refresh }: { status: LabStatus; refresh: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { state, url, error: linkError, permanent } = status.link;
  // Phones open the app itself: they choose listener or contributor there.
  const address = url ? `${url}/` : null;

  useEffect(() => {
    setCopied(false);
    if (!address) {
      setQr(null);
      return;
    }
    QRCode.toDataURL(address, { width: 480, margin: 2, color: { dark: '#1a1815', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setError('Could not draw the QR code. Copy the link instead.'));
  }, [address]);

  async function send(method: 'POST' | 'DELETE', path = '/api/lab/link') {
    setError(null);
    try {
      const res = await fetch(path, { method, headers: labHeaders });
      if (!res.ok) throw new Error();
      refresh();
    } catch {
      setError('Could not reach the server.');
    }
  }

  function newLink() {
    if (window.confirm('Make a new link? The current one stops working, and every phone has to open the new one and start again.')) send('POST', '/api/lab/link/new');
  }

  return (
    <section className="mt-8 border-t border-fg pt-3" aria-labelledby="phone-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="phone-heading" className="font-semibold">Phones, anywhere</h2>
        <span data-testid="phone-link-state" className={`text-xs ${state === 'on' ? 'font-semibold text-accent' : 'text-fg-3'}`}>
          {state === 'on' ? 'On' : state === 'starting' ? 'Starting' : state === 'error' ? 'Trying again' : 'Off'}
        </span>
      </div>
      {state === 'on' && address ? (
        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start">
          {qr && <img src={qr} alt="QR code that opens PeerBeats on a phone" className="h-44 w-44 shrink-0" data-testid="phone-link-qr" />}
          <div className="min-w-0 flex-1 text-sm">
            <p className="text-fg-2">Send this link to a phone anywhere, or scan the code. It works on any Wi-Fi or mobile data, with nothing to install. Each person picks Listener or Contributor.</p>
            <p className="mt-2 break-all font-mono text-xs" data-testid="phone-link-url">{address}</p>
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(address).then(() => setCopied(true)).catch(() => {});
                }}
                className="underline underline-offset-2"
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
              {!permanent && <button onClick={newLink} className="underline underline-offset-2">New link</button>}
              <button onClick={() => send('DELETE')} className="underline underline-offset-2">Turn off</button>
            </div>
            <p className="mt-2 text-xs text-fg-2">
              Anyone with the link can use PeerBeats while it’s on. The Lab and the demo accounts stay on this computer.
              {!permanent && ' The link changes each time PeerBeats starts, so phones then need the new one.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          {state === 'off' ? (
            <>
              <button onClick={() => send('POST')} className="border border-fg px-3 py-1 font-semibold hover:bg-fg hover:text-ink">Turn on</button>
              <span className="text-fg-2">Off. No phone can reach PeerBeats.</span>
            </>
          ) : state === 'starting' ? (
            <span className="text-fg-2">Getting a secure link from Cloudflare, about 10 seconds.</span>
          ) : (
            <p role="alert" className="text-danger">{linkError} PeerBeats keeps trying by itself.</p>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}

function DataReset({ refresh }: { refresh: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  async function clear() {
    if (!window.confirm('Clear every delivery record and payout? Accounts, plans, payments and music stay.')) return;
    const res = await fetch('/api/lab/reset-activity', { method: 'POST', headers: labHeaders }).catch(() => null);
    setMessage(res?.ok ? 'Cleared.' : 'Could not clear.');
    refresh();
  }
  return (
    <section className="mt-8 border-t border-fg pt-3" aria-labelledby="data-heading">
      <h2 id="data-heading" className="font-semibold">Data</h2>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <button onClick={clear} className="border border-fg px-3 py-1 hover:bg-fg hover:text-ink">Clear deliveries and payouts</button>
        <span className="text-fg-2">Start the next demo with empty records.</span>
        {message && <span role="status">{message}</span>}
      </div>
    </section>
  );
}

function PaymentSetup({ status, refresh }: { status: LabStatus; refresh: () => void }) {
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = 'mt-1 w-full rounded border border-line bg-ink-2 px-2 py-1 text-xs outline-none focus:border-accent';

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/lab/payment-keys', { method: 'POST', headers: labHeaders, body: JSON.stringify({ keyId, keySecret, webhookSecret }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not save those keys.');
      setKeyId('');
      setKeySecret('');
      setWebhookSecret('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save those keys.');
    } finally {
      setBusy(false);
    }
  }

  const { configured, portalActive } = status.payments;
  return (
    <section className="mt-8 border-t border-fg pt-3" aria-labelledby="payments-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="payments-heading" className="font-semibold">Payments</h2>
        <span data-testid="payments-state" className={`text-xs ${configured || portalActive ? 'font-semibold text-accent' : 'text-fg-3'}`}>
          {configured ? 'Razorpay test mode' : portalActive ? 'Test checkout on' : 'Off'}
        </span>
      </div>
      {!configured && !portalActive && (
        <p className="mt-1 text-sm text-fg-2">Enter the activation code on the Plan page of any account.</p>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-fg-2">{configured ? 'Change Razorpay keys' : 'Use Razorpay test keys instead'}</summary>
        <form onSubmit={save} className="mt-2 max-w-sm space-y-2">
          <label className="block text-xs text-fg-2">Key ID (rzp_test_...)
            <input className={field} value={keyId} onChange={(e) => setKeyId(e.target.value)} autoComplete="off" spellCheck={false} required />
          </label>
          <label className="block text-xs text-fg-2">Key secret
            <input className={field} type="password" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} autoComplete="off" required />
          </label>
          <label className="block text-xs text-fg-2">Webhook secret (optional)
            <input className={field} type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="off" />
          </label>
          {error && <p role="alert" className="text-danger">{error}</p>}
          <button type="submit" disabled={busy} className="border border-fg px-3 py-1 font-semibold hover:bg-fg hover:text-ink disabled:opacity-60">
            {busy ? 'Checking' : 'Save'}
          </button>
        </form>
      </details>
    </section>
  );
}

export function Lab() {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const user = useAuth((s) => s.user);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/lab/status', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as LabStatus;
      if (alive.current) {
        setStatus(data);
        setOffline(false);
      }
    } catch {
      if (alive.current) setOffline(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    markAsLabTab();
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const local = status?.local ?? true;
  const peersOnline = status?.network.peers.length ?? 0;
  const playing = status?.network.listeners.filter((l) => l.state === 'playing').length ?? 0;

  function open(role: Role) {
    const url = demoLink(role.role, role.go);
    // A laptop keeps every role running in its own tab. A phone is one person at a time.
    if (local) openOrFocusTab(url, `pb-${role.role}`);
    else window.location.assign(url);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4 pb-12 sm:p-8">
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-fg pb-2">
          <h1 className="text-lg">PeerBeats lab</h1>
          <p className="text-xs text-fg-2">
            {offline ? <span className="font-semibold text-danger">Server not reachable</span> : `${peersOnline} ${peersOnline === 1 ? 'contributor' : 'contributors'} online, ${playing} listening`}
          </p>
        </header>

        <div className="mt-6 grid gap-8 sm:grid-cols-2">
          <RoleList title="Contributors" roles={CONTRIBUTORS} status={status} onOpen={open} />
          <RoleList title="Listeners" roles={LISTENERS} status={status} onOpen={open} />
        </div>
        <div className="mt-8">
          <RoleList title="Admin" roles={[ADMIN]} status={status} onOpen={open} />
        </div>

        {status?.local && <PhoneLink status={status} refresh={refresh} />}
        {status?.local && <PaymentSetup status={status} refresh={refresh} />}
        {status?.local && <DataReset refresh={refresh} />}
        <InstallCard />

        {user && (
          <p className="mt-8 text-xs text-fg-3">
            {user.displayName} is signed in on this tab.{' '}
            <Link to="/" className="underline underline-offset-2 hover:text-fg">Open the app</Link>
            {' / '}
            <button onClick={endSession} className="underline underline-offset-2 hover:text-fg">Log out</button>
          </p>
        )}
      </div>
    </div>
  );
}
