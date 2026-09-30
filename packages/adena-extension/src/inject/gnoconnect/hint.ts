import { GNO_STATE_HINT_STATUS } from './types';

// Where the wallet keeps everything, and the fields a page's GnoConnect view depends on.
const STORAGE_KEY = 'ADENA_DATA';
const WATCHED_FIELDS = ['CURRENT_ACCOUNT_ID', 'CURRENT_NETWORK_ID', 'ESTABLISH_SITES'];

function watched(raw: unknown): string {
  try {
    const data = JSON.parse(typeof raw === 'string' ? raw : '{}')?.data ?? {};
    return JSON.stringify(WATCHED_FIELDS.map((field) => data[field] ?? null));
  } catch {
    return '';
  }
}

/** A `chrome.storage.onChanged` batch that moved the account, network or approved sites. */
export function isGnoConnectStateChange(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): boolean {
  const change = changes[STORAGE_KEY];
  return area === 'local' && !!change && watched(change.oldValue) !== watched(change.newValue);
}

/**
 * Tells every tab that wallet state may have changed. It carries nothing, so it
 * can go everywhere: each provider re-reads through its gated channel, and only
 * approved origins learn anything.
 */
export function broadcastGnoConnectHint(): void {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id !== undefined) {
        // Tabs without our content script (chrome://, the store) reject; nothing to tell them.
        chrome.tabs.sendMessage(tab.id, { status: GNO_STATE_HINT_STATUS }).catch(() => undefined);
      }
    });
  });
}
