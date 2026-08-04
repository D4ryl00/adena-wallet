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
 * The announce half of the GnoConnect in-page handshake.
 *
 * Neither side can assume it loaded first, which is the whole difficulty. So the
 * wallet announces on load *and* on every `gno:requestWallet`: announcing once
 * makes it invisible to any page that started listening afterwards.
 *
 * This replaces the `window.<wallet>` namespace race — with a single global, the
 * last extension to load wins and the rest become unreachable, so a user with two
 * wallets installed cannot get at one of them. `window.adena` stays for existing
 * dApps, but it is no longer how a GnoConnect page finds Adena.
 */

/**
 * Marks a target as already announced on.
 *
 * On the target rather than in module scope, because module scope is exactly
 * what a re-injection does not share: a second evaluation of the bundle gets a
 * fresh copy of every module-level binding, so a `let announced` here would be
 * `false` again and the page would receive a second announcement. The target
 * — `window`, in the only case that matters — is the thing that survives.
 */
const ANNOUNCED_FLAG = '__adenaGnoConnectAnnounced';

type AnnounceTarget = EventTarget & { [ANNOUNCED_FLAG]?: true };

/**
 * @param target the event target to announce on. Defaults to `window`, which is
 *   what the page listens on; parameterised so tests get an isolated target
 *   rather than leaking listeners onto a shared one.
 */
export function announceGnoWallet(target: EventTarget = window): void {
  // The injected script can be evaluated more than once for a document (a
  // re-injection, a same-document navigation). Announcing again would register a
  // second `gno:requestWallet` listener and hand the page two entries with
  // different uuids for one wallet, which is exactly what `uuid` exists to
  // prevent. Announce once; the listener below covers every later request.
  const host = target as AnnounceTarget;
  if (host[ANNOUNCED_FLAG]) {
    return;
  }

  // Non-configurable and non-writable: the flag lives on an object the page can
  // reach, and a page that could clear it could force the second announcement
  // this guard exists to prevent.
  Object.defineProperty(host, ANNOUNCED_FLAG, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  const info: GnoWalletInfo = Object.freeze({
    // Unique per page load. Lets a page deduplicate our repeated announcements;
    // `rdns` is the identity that survives reloads and versions.
    uuid: uuidv4(),
    name: 'Adena',
    icon: ADENA_ICON_DATA_URI,
    rdns: ADENA_RDNS,
  });

  const provider = createGnoConnectProvider();

  // Frozen so a page — or anything else running in it — cannot swap our methods
  // out from under a later caller holding the same detail object.
  const detail: GnoWalletAnnouncement = Object.freeze({ info, provider });

  const announce = (): void => {
    target.dispatchEvent(new CustomEvent(GNO_REGISTER_WALLET_EVENT, { detail }));
  };

  target.addEventListener(GNO_REQUEST_WALLET_EVENT, announce);
  announce();
}
