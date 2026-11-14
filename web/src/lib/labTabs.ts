const LAB_TAB = 'peerbeats-lab';

export const markAsLabTab = () => {
  window.name = LAB_TAB;
};

/**
 * Opens a named tab, or brings it forward untouched if it already exists. A second
 * click must not reload it, because that would stop its music or its sharing.
 */
export function openOrFocusTab(url: string, tabName: string) {
  const tab = window.open('', tabName);
  if (!tab) {
    window.location.assign(url);
    return;
  }
  let isNew = true;
  try {
    isNew = tab.location.href === 'about:blank';
  } catch {
    isNew = true;
  }
  if (isNew) tab.location.href = url;
  tab.focus();
}

/** True when this tab was opened from the Lab tab, so the Lab is still open elsewhere. */
export const cameFromLabTab = () => {
  try {
    return Boolean(window.opener && !window.opener.closed);
  } catch {
    return false;
  }
};

export const focusLabTab = () => openOrFocusTab('/lab', LAB_TAB);
