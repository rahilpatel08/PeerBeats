import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyDemoLink } from './lib/demoLink';
import { watchForInstallPrompt } from './lib/install';

watchForInstallPrompt();

// Browsers only allow this on HTTPS and localhost. The app works the same without it.
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // An installed app first opens the version it has cached, while a newer one installs. When the
  // newer one takes over right after opening, switch to it. Later, wait for the next launch instead,
  // so music and sharing are never cut off.
  const hadVersion = Boolean(navigator.serviceWorker.controller);
  const openedAt = Date.now();
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadVersion && Date.now() - openedAt < 15000) window.location.reload();
  });
}

/**
 * An app opened from the iPhone Home Screen draws its page from the top of the screen, under the
 * status bar, so the top is padded by the status bar's height. Some iOS versions make the page
 * shorter than the screen and keep the strip below it, home indicator included, for themselves.
 * There the bottom needs no room for the home indicator; elsewhere it does.
 */
function fitHomeScreenApp() {
  if (!window.matchMedia('(display-mode: standalone)').matches) return;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom) 0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const root = document.documentElement;
  root.classList.add('home-screen-app');
  const update = () => {
    const portrait = window.innerHeight >= window.innerWidth;
    const screenHeight = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const style = getComputedStyle(probe);
    const shortfall = Math.max(0, screenHeight - window.innerHeight);
    root.style.setProperty('--status-bar', style.paddingTop);
    root.style.setProperty('--bottom-inset', `${Math.max(0, parseFloat(style.paddingBottom) - shortfall)}px`);
  };
  update();
  window.addEventListener('resize', update);
}
fitHomeScreenApp();

applyDemoLink().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
});
