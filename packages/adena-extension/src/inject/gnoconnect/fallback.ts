import { GNO_PACKAGE_PREFIX } from '@common/constants/metatag.constant';
import { GNO_FUNC_PARAM, GNO_HELP_MARKER, GNO_SEND_PARAM } from '@common/constants/url.constant';
import {
  parseGnoConnectChainId,
  parseGnoConnectTxDomains,
} from '@inject/message/methods/gno-connect';

import {
  FallbackReply,
  FallbackSendTx,
  GNO_FALLBACK_SEND_TX,
  GNO_REQUEST_WALLET_EVENT,
  GnoErrorCode,
  GnoTransactionIntent,
  UserResponse,
} from './types';

/**
 * GnoConnect "Pages that never ask": on a page that has not dispatched
 * `gno:requestWallet` (page JavaScript off, or a page predating the protocol),
 * a TxLink navigation is the only route to the wallet, so it is taken here and
 * handled as a `sendTx` without `signer`.
 */

// Failures where the user never got an answer to give: the navigation goes
// ahead so they land on the page's own fallback (gnoweb's gnokey command).
const PROCEED_CODES: ReadonlySet<GnoErrorCode> = new Set(['invalid_request', 'unsupported_host']);

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** A TxLink as a `sendTx` intent, or null when `href` is not one. */
export function parseTxLink(
  href: string,
  base: string = window.location.href,
): GnoTransactionIntent | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }

  const marker = url.pathname.indexOf(GNO_HELP_MARKER);
  if (marker < 0) {
    return null;
  }

  const realm = url.pathname.slice(0, marker).replace(/^\/+/, '');
  if (realm === '') {
    return null;
  }

  const intent: GnoTransactionIntent = {
    path: `${GNO_PACKAGE_PREFIX}/${realm}`,
    func: '',
    args: [],
  };
  for (const part of url.pathname.slice(marker + GNO_HELP_MARKER.length).split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = decode(part.slice(0, eq));
    const value = decode(part.slice(eq + 1));
    if (key === null || value === null) {
      return null;
    }

    if (key === GNO_FUNC_PARAM) {
      intent.func = value;
    } else if (key === GNO_SEND_PARAM) {
      if (value !== '') {
        intent.send = value;
      }
    } else if (!key.startsWith('.')) {
      // `.`-prefixed keys are gnoweb webargs, never realm parameters.
      intent.args.push({ name: key, value });
    }
  }

  return intent.func === '' ? null : intent;
}

/** A GET form whose `action` is a TxLink; its fields fill the link's arguments. */
export function parseTxForm(form: HTMLFormElement): GnoTransactionIntent | null {
  if (form.method.toLowerCase() !== 'get') {
    return null;
  }

  const intent = parseTxLink(form.action);
  if (intent === null) {
    return null;
  }

  let otherFunc = false;
  new FormData(form).forEach((value, key) => {
    if (typeof value !== 'string' || key.startsWith('.')) {
      return;
    }
    if (key === GNO_FUNC_PARAM) {
      otherFunc ||= value !== intent.func;
      return;
    }

    const at = intent.args.findIndex((arg) => 'name' in arg && arg.name === key);
    if (at < 0) {
      intent.args.push({ name: key, value });
    } else {
      intent.args[at] = { name: key, value };
    }
  });

  return otherFunc ? null : intent;
}

/** `gnoconnect:txdomains`, or the page's own origin when it declares none. */
export function isTxSource(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target, window.location.href);
  } catch {
    return false;
  }

  const own = url.origin === window.location.origin;
  const declared = parseGnoConnectTxDomains();
  if (declared === null) {
    return own;
  }
  return declared.some((domain) =>
    domain === 'auto' ? own : domain !== '' && (domain === url.host || domain === url.hostname),
  );
}

type SendTx = (intent: GnoTransactionIntent) => Promise<UserResponse<{ hash: string }>>;

// The provider runs in the background: a page with scripts blocked cannot load it
// here, and it would weigh megabytes on every page this content script visits.
const sendViaBackground: SendTx = (intent) =>
  new Promise((resolve, reject) => {
    const request: FallbackSendTx = {
      type: GNO_FALLBACK_SEND_TX,
      intent: { ...intent, chainid: parseGnoConnectChainId() },
      siteName: document.title || window.location.hostname,
    };
    chrome.runtime.sendMessage(request, (reply?: FallbackReply) => {
      if (chrome.runtime.lastError || !reply) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'The wallet did not answer'));
      } else if ('error' in reply) {
        reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
      } else {
        resolve(reply.response);
      }
    });
  });

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Must run before the page's scripts (content script at `document_start`):
 * a request dispatched before we listen would read as a page that never asked.
 */
export function installNoScriptFallback(
  target: Window = window,
  send: SendTx = sendViaBackground,
): void {
  // Tries one navigation: a Gno page, a transaction source, a TxLink; else leaves it alone.
  const tryTake = (
    event: Event,
    href: string,
    parse: () => GnoTransactionIntent | null,
    proceed: () => void,
  ): void => {
    if (event.defaultPrevented || parseGnoConnectChainId() === '' || !isTxSource(href)) {
      return;
    }
    const intent = parse();
    if (intent === null) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    send(intent).catch((error: unknown) => {
      const code = (error as { code?: GnoErrorCode })?.code;
      if (code === undefined || PROCEED_CODES.has(code)) {
        console.warn('Adena: could not take this TxLink, continuing to the page', error);
        proceed();
      }
    });
  };

  const onClick = (event: MouseEvent): void => {
    const anchor = (event.target as Element | null)?.closest?.(
      'a[href]',
    ) as HTMLAnchorElement | null;
    if (isPlainClick(event) && anchor && !anchor.hasAttribute('download')) {
      tryTake(
        event,
        anchor.href,
        () => parseTxLink(anchor.href),
        () => target.location.assign(anchor.href),
      );
    }
  };

  const onSubmit = (event: Event): void => {
    const form = event.target as HTMLFormElement | null;
    if (form) {
      // `submit()` fires no event, so proceeding cannot loop back here.
      tryTake(
        event,
        form.action,
        () => parseTxForm(form),
        () => form.submit(),
      );
    }
  };

  // Once the page asks, it is choosing: stand down for the rest of its life.
  const standDown = (): void => {
    target.removeEventListener('click', onClick, true);
    target.removeEventListener('submit', onSubmit, true);
  };

  target.addEventListener(GNO_REQUEST_WALLET_EVENT, standDown, { once: true });
  target.addEventListener('click', onClick, true);
  target.addEventListener('submit', onSubmit, true);
}
