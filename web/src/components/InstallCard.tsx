import { useEffect, useState } from 'react';
import { canPromptInstall, isInApp, isInstalled, isIos, onInstallChange, promptInstall } from '../lib/install';

export function InstallCard() {
  const [, redraw] = useState(0);
  useEffect(() => onInstallChange(() => redraw((n) => n + 1)), []);
  if (isInstalled() || isInApp() || !window.isSecureContext) return null;
  const canPrompt = canPromptInstall();

  return (
    <section className="mt-8 border-t border-fg pt-3" aria-labelledby="install-heading">
      <h2 id="install-heading" className="font-semibold">Install</h2>
      <p className="mt-2 text-sm text-fg-2">
        {canPrompt
          ? 'Add PeerBeats to this device.'
          : isIos()
            ? 'In Safari, tap Share, then Add to Home Screen.'
            : 'Use Install in your browser menu.'}
      </p>
      {canPrompt && (
        <button onClick={() => promptInstall()} className="mt-3 px-4 py-2 text-sm font-semibold border border-fg hover:bg-fg hover:text-ink">
          Install
        </button>
      )}
      {/\.trycloudflare\.com$/.test(location.hostname) && (
        <p className="mt-2 text-xs text-fg-3">
          This link changes each time PeerBeats starts, so an icon added from it stops working later.
        </p>
      )}
    </section>
  );
}
