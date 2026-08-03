// The provider pulls in the executor and the SDK; neither is under test here,
// and the SDK loads @web3auth's native crypto, which fails under jsdom.
jest.mock('./provider', () => ({
  createGnoConnectProvider: (): Record<string, unknown> =>
    Object.freeze({ signAndSubmitTransaction: jest.fn() }),
}));

import {
  GNO_REGISTER_WALLET_EVENT,
  GNO_REQUEST_WALLET_EVENT,
  GnoWalletAnnouncement,
} from './types';

type Announce = (target?: EventTarget) => void;

/**
 * `announceGnoWallet` is idempotent per module instance, so each test needs a
 * fresh registry — otherwise the second call in a test file is a no-op.
 */
function freshAnnounce(): Announce {
  let announce: Announce = () => undefined;
  jest.isolateModules(() => {
    // A static import would bind once for the whole file, defeating the point:
    // the module must be re-evaluated so its idempotency flag resets.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    announce = require('./announce').announceGnoWallet;
  });
  return announce;
}

/** A target per test, so listeners never leak between them via jsdom's window. */
function setup(): { target: EventTarget; seen: GnoWalletAnnouncement[]; announce: Announce } {
  const target = new EventTarget();
  const seen: GnoWalletAnnouncement[] = [];
  target.addEventListener(GNO_REGISTER_WALLET_EVENT, (event) => {
    seen.push((event as CustomEvent<GnoWalletAnnouncement>).detail);
  });
  return { target, seen, announce: freshAnnounce() };
}

describe('announceGnoWallet', () => {
  it('announces immediately, for a page that was already listening', () => {
    const { target, seen, announce } = setup();

    announce(target);

    expect(seen).toHaveLength(1);
    expect(seen[0].info.name).toBe('Adena');
  });

  // A wallet that announces only once is invisible to any page that started
  // listening afterwards — the page cannot know the first answer was the last.
  it('re-announces on every gno:requestWallet', () => {
    const { target, seen, announce } = setup();
    announce(target);

    target.dispatchEvent(new Event(GNO_REQUEST_WALLET_EVENT));
    target.dispatchEvent(new Event(GNO_REQUEST_WALLET_EVENT));

    expect(seen).toHaveLength(3); // the initial announce, plus one per request
  });

  it('keeps one uuid across a page load so repeats deduplicate', () => {
    const { target, seen, announce } = setup();
    announce(target);

    target.dispatchEvent(new Event(GNO_REQUEST_WALLET_EVENT));

    expect(seen[0].info.uuid).toBe(seen[1].info.uuid);
  });

  // A second evaluation of the injected script must not present the page with
  // two entries for one wallet.
  it('is idempotent when called more than once', () => {
    const { target, seen, announce } = setup();

    announce(target);
    announce(target);
    target.dispatchEvent(new Event(GNO_REQUEST_WALLET_EVENT));

    expect(seen).toHaveLength(2); // one announce, one request — not doubled
  });

  it('announces a UUIDv4 handle', () => {
    const { target, seen, announce } = setup();

    announce(target);

    expect(seen[0].info.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('gives each page load a distinct uuid', () => {
    const first = setup();
    const second = setup();

    first.announce(first.target);
    second.announce(second.target);

    expect(first.seen[0].info.uuid).not.toBe(second.seen[0].info.uuid);
  });

  // A remote URL would leak the page visit and let the chooser entry render
  // arbitrary fetched content; the standard allows only a data: image.
  it('announces the icon as a data:image/ URI', () => {
    const { target, seen, announce } = setup();

    announce(target);

    expect(seen[0].info.icon.startsWith('data:image/')).toBe(true);
  });

  it('announces a reverse-DNS identity, which is what a page persists', () => {
    const { target, seen, announce } = setup();

    announce(target);

    expect(seen[0].info.rdns).toBe('land.gno.adena');
  });

  // A page holding the detail must not have its provider swapped out from
  // under it by anything else running in the page.
  it('freezes the announced detail, info and provider', () => {
    const { target, seen, announce } = setup();

    announce(target);

    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0].info)).toBe(true);
    expect(Object.isFrozen(seen[0].provider)).toBe(true);
  });
});
