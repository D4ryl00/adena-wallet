import { v4 as uuidv4 } from 'uuid';

import { ADENA_ICON_DATA_URI } from './icon';
import { createGnoConnectProvider } from './provider';
import {
  ADENA_RDNS,
  GNO_REGISTER_WALLET_EVENT,
  GNO_REQUEST_WALLET_EVENT,
  GnoWalletAnnouncement,
  GnoWalletInfo,
} from './types';

/**
 * The announce half of the handshake. Neither side can assume it loaded first,
 * so the wallet announces on load *and* on every `gno:requestWallet` — announcing
 * once makes it invisible to a page that started listening afterwards.
 *
 * Replaces the `window.<wallet>` race, where the last extension to load wins and
 * the rest become unreachable. `window.adena` stays for existing dApps.
 */

// On the target, not in module scope: a re-injected bundle gets fresh module
// bindings, so a `let` here would be false again and announce twice.
const ANNOUNCED_FLAG = '__adenaGnoConnectAnnounced';

type AnnounceTarget = EventTarget & { [ANNOUNCED_FLAG]?: true };

/** @param target defaults to `window`; parameterised so tests get isolation. */
export function announceGnoWallet(target: EventTarget = window): void {
  // Evaluated more than once per document, announcing again would hand the page
  // two entries with different uuids for one wallet.
  const host = target as AnnounceTarget;
  if (host[ANNOUNCED_FLAG]) {
    return;
  }

  // Non-configurable: the flag sits on an object the page can reach.
  Object.defineProperty(host, ANNOUNCED_FLAG, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  const info: GnoWalletInfo = Object.freeze({
    // Unique per page load, for deduplicating repeats; `rdns` survives reloads.
    uuid: uuidv4(),
    name: 'Adena',
    icon: ADENA_ICON_DATA_URI,
    rdns: ADENA_RDNS,
  });

  const provider = createGnoConnectProvider();

  // Frozen so nothing in the page can swap our methods out from under a caller.
  const detail: GnoWalletAnnouncement = Object.freeze({ info, provider });

  const announce = (): void => {
    target.dispatchEvent(new CustomEvent(GNO_REGISTER_WALLET_EVENT, { detail }));
  };

  target.addEventListener(GNO_REQUEST_WALLET_EVENT, announce);
  announce();
}
