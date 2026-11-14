import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { formatRupees } from '../lib/format';
import { useAuth } from '../store/auth';
import { usePlan, type Access } from '../store/plan';

interface Status {
  configured: boolean;
  portalActive: boolean;
  demoMode: boolean;
  access: { active: boolean; plan: 'monthly' | 'credits' | null; endsAt: string | null; credits: number };
  plans: { monthly: { paise: number; days: number }; credits: { paise: number; credits: number } };
}

interface Order {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  plan: 'monthly' | 'credits';
}

const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

function loadCheckout(): Promise<void> {
  if ((window as any).Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Razorpay. Check your internet connection.'));
    document.head.appendChild(script);
  });
}

export function Subscribe() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'monthly' | 'credits' | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      api<Status>('/api/subscription')
        .then((next) => {
          setStatus(next);
          // The menu's plan check reads the same answer.
          usePlan.getState().set(next.access);
        })
        .catch((err) => setError(err.message)),
    [],
  );
  useEffect(() => {
    refresh();
  }, [refresh]);

  /** The lab's free plan: the right code turns on a monthly plan, then it's straight to the music. */
  async function redeemCode(e: FormEvent) {
    e.preventDefault();
    setCodeError(null);
    try {
      const { access } = await api<{ access: Access }>('/api/payments/code', { method: 'POST', body: { code } });
      setCode('');
      usePlan.getState().set(access);
      navigate('/', { replace: true });
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : 'That didn\u2019t work.');
    }
  }

  async function turnOff() {
    await api('/api/payments/portal', { method: 'DELETE' }).catch(() => {});
    await refresh();
  }

  async function payOnPortal(plan: 'monthly' | 'credits') {
    setBusy(plan);
    setError(null);
    try {
      await api('/api/payments/portal/pay', { method: 'POST', body: { plan } });
      await refresh();
      setSuccess(plan === 'monthly' ? 'Paid. Monthly plan is on.' : 'Paid. Credits added.');
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The payment failed.');
    } finally {
      setBusy(null);
    }
  }

  async function buy(plan: 'monthly' | 'credits') {
    // Real Razorpay test keys win. Otherwise it's the built-in test checkout.
    if (!status?.configured) {
      setError(null);
      setSuccess(null);
      setConfirming(plan);
      return;
    }
    setBusy(plan);
    setError(null);
    setSuccess(null);
    try {
      const order = await api<Order>('/api/payments/order', { method: 'POST', body: { plan } });
      await loadCheckout();
      await new Promise<void>((resolve, reject) => {
        const checkout = new (window as any).Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: 'PeerBeats',
          description: plan === 'monthly' ? 'Monthly plan' : 'Credit pack',
          prefill: { email: user?.email, name: user?.displayName },
          theme: { color: '#1d3fc4' },
          handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
            try {
              // Nothing is activated until the server has checked Razorpay's signature.
              await api('/api/payments/verify', { method: 'POST', body: response });
              // Update the status first, so "verified" never appears beside "no plan".
              await refresh();
              setSuccess(plan === 'monthly' ? 'Payment verified. Your monthly plan is active.' : 'Payment verified. Your credits are ready.');
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          modal: { ondismiss: () => resolve() },
        });
        checkout.on('payment.failed', (response: { error?: { description?: string } }) => {
          setError(response.error?.description ?? 'The payment failed. You were not charged.');
        });
        checkout.open();
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The payment could not be completed.');
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <h1 className="text-lg">Plan</h1>
        {error ? <p role="alert" className="mt-4 text-sm text-danger">{error}</p> : <div className="skeleton mt-4 h-48 rounded-xl" />}
      </div>
    );
  }

  const { access, plans, configured, portalActive, demoMode } = status;
  const canBuy = configured || portalActive;
  const current = access.plan === 'monthly'
    ? `Monthly plan, active until ${new Date(access.endsAt!).toLocaleDateString()}`
    : access.plan === 'credits'
      ? `${access.credits} credits left. One credit plays one song.`
      : 'You don’t have a plan yet, so you can’t get music.';
  const cards = [
    { plan: 'monthly' as const, name: 'Monthly', price: plans.monthly.paise, detail: `Listen as much as you like for ${plans.monthly.days} days.` },
    { plan: 'credits' as const, name: 'Credit pack', price: plans.credits.paise, detail: `${plans.credits.credits} credits. One credit plays one song. Credits don’t expire.` },
  ];

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <h1 className="text-lg">Plan</h1>

      <p
        data-testid="plan-status"
        className={`mt-3 text-sm ${access.active ? 'font-semibold text-fg' : 'text-fg-2'}`}
      >
        {current}
      </p>
      {success && <p role="status" data-testid="plan-success" className="mt-3 text-sm text-accent">{success} <Link to="/" className="underline underline-offset-2">Find some music</Link></p>}
      {error && <p role="alert" data-testid="plan-error" className="mt-3 text-sm text-danger">{error}</p>}

      {demoMode && !access.active && (
        <form onSubmit={redeemCode} className="mt-4 border-y border-fg py-3 text-sm" data-testid="plan-code">
          <label htmlFor="portal-code" className="font-semibold">Have a code?</label>
          <div className="mt-2 flex gap-2">
            <input
              id="portal-code"
              data-testid="portal-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              required
              className="min-w-0 flex-1 border border-line bg-ink-2 px-2 py-1.5 text-base outline-none focus:border-fg"
            />
            <button type="submit" className="border border-fg px-4 py-1.5 font-semibold hover:bg-fg hover:text-ink">Use code</button>
          </div>
          {codeError && <p role="alert" data-testid="portal-error" className="mt-2 text-danger">{codeError}</p>}
        </form>
      )}
      {!canBuy && <p data-testid="plan-unconfigured" className="mt-3 text-xs text-fg-3">Card and UPI payments are off.</p>}
      {portalActive && !configured && (
        <p data-testid="portal-on" className="mt-3 text-sm text-fg-2">
          Test checkout is on. No real money moves.{' '}
          <button onClick={turnOff} className="underline underline-offset-2 hover:text-fg">Turn off</button>
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-fg text-left text-xs text-fg-3">
              <th className="py-1 pr-3 font-normal">Plan</th>
              <th className="py-1 pr-3 text-right font-normal">Price</th>
              <th className="py-1 pr-3 font-normal">Includes</th>
              <th className="py-1 font-normal" />
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => (
              <tr key={card.plan} className="border-b border-line">
                <td className="py-2 pr-3 font-semibold">{card.name}</td>
                <td className="py-2 pr-3 text-right font-mono">{formatRupees(card.price)}</td>
                <td className="py-2 pr-3 text-fg-2">{card.detail}</td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => buy(card.plan)}
                    disabled={!canBuy || busy !== null}
                    className="whitespace-nowrap border border-fg px-3 py-1 font-semibold hover:bg-fg hover:text-ink disabled:border-line disabled:text-fg-3 disabled:hover:bg-transparent"
                  >
                    {busy === card.plan ? 'Opening' : `Buy ${card.name.toLowerCase()}`}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="checkout-heading">
          <div data-testid="portal-checkout" className="w-full max-w-sm border border-fg bg-ink-2 p-5">
            <h2 id="checkout-heading" className="text-lg font-semibold">Test checkout</h2>
            <dl className="mt-3 text-sm">
              <div className="flex justify-between border-t border-line py-2">
                <dt className="text-fg-2">{confirming === 'monthly' ? 'Monthly plan' : 'Credit pack'}</dt>
                <dd className="font-semibold">{formatRupees(plans[confirming].paise).replace('.00', '')}</dd>
              </div>
            </dl>
            <p className="border-t border-line pt-2 text-xs text-fg-2">Test only. No card needed, and no real money moves.</p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => payOnPortal(confirming)}
                disabled={busy !== null}
                className="flex-1 bg-fg py-2 text-sm font-semibold text-ink disabled:opacity-60"
              >
                Pay {formatRupees(plans[confirming].paise).replace('.00', '')}
              </button>
              <button onClick={() => setConfirming(null)} className="rounded border border-line px-4 py-2 text-sm text-fg-2 hover:text-fg">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {configured && (
        <section className="mt-6 border-t border-fg pt-2 text-sm" aria-labelledby="test-heading">
          <h2 id="test-heading" className="font-semibold">Test mode: no real money moves</h2>
          <p className="mt-1 text-fg-2">Use these on the Razorpay screen:</p>
          <ul className="mt-2 space-y-1 text-fg-2">
            <li>Card <span className="font-mono text-fg">4100 2800 0000 1007</span>, any future expiry, any CVV, then any OTP of 4 to 10 digits.</li>
            <li>Or UPI <span className="font-mono text-fg">success@razorpay</span>. Use <span className="font-mono text-fg">failure@razorpay</span> to see a failed payment.</li>
          </ul>
        </section>
      )}
    </div>
  );
}
