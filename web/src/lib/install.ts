/** Chrome and Android offer an install prompt once. Keep it for when the person asks. */
let prompt: (Event & { prompt: () => Promise<void> }) | null = null;
const listeners = new Set<() => void>();

export function watchForInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    prompt = event as typeof prompt;
    listeners.forEach((listener) => listener());
  });
  window.addEventListener('appinstalled', () => {
    prompt = null;
    listeners.forEach((listener) => listener());
  });
}

export const canPromptInstall = () => prompt !== null;

export const onInstallChange = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export async function promptInstall() {
  const current = prompt;
  prompt = null;
  await current?.prompt();
  listeners.forEach((listener) => listener());
}

export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

/** True inside the PeerBeats iPhone app, which identifies itself in its user agent. */
export const isInApp = () => /PeerBeatsApp\//.test(navigator.userAgent);
