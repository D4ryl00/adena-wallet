// The SDK loads @web3auth's native crypto, which fails under jsdom. Handlers
// and the response mapper use these enum values as plain strings.
jest.mock('@adena-wallet/sdk', () => ({
  WalletResponseStatus: { SUCCESS: 'success', FAILURE: 'failure' },
  WalletResponseFailureType: {
    ALREADY_CONNECTED: 'ALREADY_CONNECTED',
    REDUNDANT_CHANGE_REQUEST: 'REDUNDANT_CHANGE_REQUEST',
    INVALID_FORMAT: 'INVALID_FORMAT',
    WALLET_LOCKED: 'WALLET_LOCKED',
  },
  WalletResponseRejectType: {
    TRANSACTION_REJECTED: 'TRANSACTION_REJECTED',
    SIGN_REJECTED: 'SIGN_REJECTED',
    CONNECTION_REJECTED: 'CONNECTION_REJECTED',
    SWITCH_NETWORK_REJECTED: 'SWITCH_NETWORK_REJECTED',
    ADD_NETWORK_REJECTED: 'ADD_NETWORK_REJECTED',
  },
  WalletResponseExecuteType: {
    ADD_ESTABLISH: 'ADD_ESTABLISH',
    DO_CONTRACT: 'DO_CONTRACT',
    GET_ACCOUNT: 'GET_ACCOUNT',
    GET_NETWORK: 'GET_NETWORK',
    SWITCH_NETWORK: 'SWITCH_NETWORK',
  },
  WalletMessageInfo: new Proxy(
    {},
    {
      get: (_target, type: string): Record<string, unknown> => ({
        code: 0,
        status: 'request',
        type,
        message: '',
      }),
    },
  ),
}));

// Argument resolution needs a live node (`vm/qdoc`); it is covered on its own in
// `tx-builder.spec.ts`. Here the concern is the handshake and the response
// contract, so the realm lookup is stubbed out.
jest.mock('./tx-builder', () => ({
  buildTransactionParams: jest.fn(async () => ({
    messages: [
      {
        type: '/vm.m_call',
        value: {
          caller: '',
          send: '',
          pkg_path: 'gno.land/r/demo/boards',
          func: 'CreateThread',
          args: ['2', 'title'],
          max_deposit: '',
        },
      },
    ],
    gasFee: 0,
    gasWanted: 10000000,
    arguments: null,
  })),
}));

import { announceGnoWallet } from './announce';
import { GnoConnectError } from './response';
import {
  GNO_REGISTER_WALLET_EVENT,
  GNO_REQUEST_WALLET_EVENT,
  GnoWalletAnnouncement,
} from './types';

/**
 * Stands in for the content script plus the background: captures the request the
 * executor posts and dispatches a reply carrying the same correlation key.
 *
 * jsdom's `postMessage` delivers `event.origin` as `''`, which the executor's
 * origin check discards, so the reply is dispatched as an explicit
 * `MessageEvent` instead — the same approach as `executor-cosmos.spec.ts`. The
 * reply is deferred by a tick because the executor installs its resolver only
 * after `postMessage` returns.
 */
function bridge(reply: (request: any) => Record<string, unknown>): () => void {
  const original = window.postMessage.bind(window);
  const spy = jest.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
    const request = message as Record<string, unknown>;
    if (request?.status !== 'request') {
      return;
    }
    setTimeout(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { ...request, ...reply(request) },
          origin: window.location.origin,
        }),
      );
    }, 0);
  });

  return (): void => {
    spy.mockRestore();
    window.postMessage = original;
  };
}

/** The page side of the handshake, exactly as the standard writes it. */
function discoverWallet(): Promise<GnoWalletAnnouncement> {
  return new Promise((resolve) => {
    window.addEventListener(GNO_REGISTER_WALLET_EVENT, (event) => {
      resolve((event as CustomEvent<GnoWalletAnnouncement>).detail);
    });
    window.dispatchEvent(new Event(GNO_REQUEST_WALLET_EVENT));
  });
}

const ACTIVE_CHAIN_ID = 'dev';
const ACTIVE_RPC_URL = 'http://127.0.0.1:26657';

const INTENT = {
  path: 'gno.land/r/demo/boards',
  func: 'CreateThread',
  args: [{ name: 'bid', value: '2' }],
  // Required: chainid selects the network. The wallet resolves it against the
  // networks the user configured and signs through that one's endpoint.
  chainid: ACTIVE_CHAIN_ID,
};

/**
 * Wraps a reply so every request first sees the wallet's active network, which
 * is what `resolveNetwork` reads before anything is built or signed.
 */
function onActiveNetwork(
  reply: (request: any) => Record<string, unknown>,
): (request: any) => Record<string, unknown> {
  return (request): Record<string, unknown> => {
    if (request.type === 'GET_NETWORK') {
      return {
        status: 'success',
        type: 'GET_NETWORK',
        data: { chainId: ACTIVE_CHAIN_ID, rpcUrl: ACTIVE_RPC_URL, networkName: 'Local' },
      };
    }
    return reply(request);
  };
}

describe('GnoConnect handshake, end to end', () => {
  let teardown: (() => void)[] = [];

  beforeAll(() => {
    // The wallet announces on load; a page that starts listening afterwards
    // still finds it, because the wallet answers every gno:requestWallet.
    announceGnoWallet();
  });

  afterEach(() => {
    teardown.forEach((fn) => fn());
    teardown = [];
  });

  it('lets a page that loaded after the wallet still discover it', async () => {
    const announcement = await discoverWallet();

    expect(announcement.info.rdns).toBe('land.gno.adena');
    expect(typeof announcement.provider.sendTx).toBe('function');
  });

  it('signs and submits, returning Approved with the tx hash', async () => {
    teardown.push(
      bridge(onActiveNetwork(() => ({ status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'deadbeef' } }))),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx(INTENT)).resolves.toEqual({
      status: 'Approved',
      args: { hash: 'deadbeef' },
    });
  });

  // The user declining is an answer, not an error.
  it('resolves Rejected when the user declines, rather than throwing', async () => {
    teardown.push(
      bridge(onActiveNetwork(() => ({ status: 'failure', type: 'TRANSACTION_REJECTED', code: 4000, data: null }))),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx(INTENT)).resolves.toEqual({
      status: 'Rejected',
    });
  });

  // A genuine failure is not an answer, so it rejects the promise.
  it('rejects the promise when the wallet is locked', async () => {
    teardown.push(
      bridge(onActiveNetwork(() => ({ status: 'failure', type: 'WALLET_LOCKED', code: 2000, data: null }))),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx(INTENT)).rejects.toBeInstanceOf(GnoConnectError);
  });

  it('connects, disclosing the account only after the establish is approved', async () => {
    const seenRequests: string[] = [];
    teardown.push(
      bridge((request) => {
        seenRequests.push(request.type);
        if (request.type === 'ADD_ESTABLISH') {
          return { status: 'success', type: 'CONNECTION_SUCCESS', data: {} };
        }
        return {
          status: 'success',
          type: 'GET_ACCOUNT',
          data: { address: 'g1abc', chainId: 'dev', publicKey: { value: 'pub' } },
        };
      }),
    );
    const { provider } = await discoverWallet();

    await expect(provider.connect()).resolves.toEqual({
      status: 'Approved',
      args: { address: 'g1abc', chainid: 'dev', pubkey: 'pub' },
    });
    expect(seenRequests).toEqual(['ADD_ESTABLISH', 'GET_ACCOUNT']);
  });

  it('does not disclose the account when the connection is declined', async () => {
    const seenRequests: string[] = [];
    teardown.push(
      bridge((request) => {
        seenRequests.push(request.type);
        return { status: 'failure', type: 'CONNECTION_REJECTED', code: 4000, data: null };
      }),
    );
    const { provider } = await discoverWallet();

    await expect(provider.connect()).resolves.toEqual({ status: 'Rejected' });
    expect(seenRequests).toEqual(['ADD_ESTABLISH']);
  });

  // Adena builds multi-message transactions natively, so the standard's
  // single-message baseline is a subset of what it can carry.
  it('accepts a multi-message call', async () => {
    teardown.push(
      bridge(onActiveNetwork(() => ({ status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'multi' } }))),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTxs([INTENT, INTENT])).resolves.toEqual({
      status: 'Approved',
      args: { hash: 'multi' },
    });
  });

  // chainid selects the network. Without one there is nothing to select, and
  // "whichever chain the wallet happens to be on" is how a dapp built for one
  // chain gets a signature valid on another.
  it('refuses a request that names no chain', async () => {
    teardown.push(bridge(onActiveNetwork(() => ({}))));
    const { provider } = await discoverWallet();

    await expect(
      provider.sendTx({ ...INTENT, chainid: undefined }),
    ).rejects.toThrow(/No chainid/);
  });

  // The page asked for a chain the wallet is not on: it prompts, and a decline
  // is network_declined rather than a silent signature on the wrong chain.
  it('declines when the user refuses to switch to the requested chain', async () => {
    teardown.push(
      bridge((request) => {
        if (request.type === 'GET_NETWORK') {
          return {
            status: 'success',
            type: 'GET_NETWORK',
            data: { chainId: 'other', rpcUrl: 'http://other', networkName: 'Other' },
          };
        }
        return { status: 'failure', type: 'SWITCH_NETWORK_REJECTED', code: 4000, data: null };
      }),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx(INTENT)).rejects.toMatchObject({
      code: 'network_declined',
    });
  });

  // Without the pin, a page that connected as one account and rendered its
  // address signs as whatever account the user has since switched to.
  it('refuses to sign as an account other than the pinned signer', async () => {
    teardown.push(
      bridge(
        onActiveNetwork(() => ({
          status: 'success',
          type: 'GET_ACCOUNT',
          data: { address: 'g1someoneelse', chainId: 'dev', publicKey: { value: 'pub' } },
        })),
      ),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx({ ...INTENT, signer: 'g1abc' })).rejects.toMatchObject({
      code: 'signer_unavailable',
    });
  });

  it('signs when the pinned signer is the active account', async () => {
    teardown.push(
      bridge(
        onActiveNetwork((request) => {
          if (request.type === 'GET_ACCOUNT') {
            return {
              status: 'success',
              type: 'GET_ACCOUNT',
              data: { address: 'g1abc', chainId: 'dev', publicKey: { value: 'pub' } },
            };
          }
          return { status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'pinned' } };
        }),
      ),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx({ ...INTENT, signer: 'g1abc' })).resolves.toEqual({
      status: 'Approved',
      args: { hash: 'pinned' },
    });
  });

  it('reports switching to the network the page asked for', async () => {
    teardown.push(
      bridge(() => ({
        status: 'success',
        type: 'SWITCH_NETWORK_SUCCESS',
        data: { chainId: 'test5' },
      })),
    );
    const { provider } = await discoverWallet();

    await expect(provider.switchNetwork('test5')).resolves.toEqual({
      status: 'Approved',
      args: { chainid: 'test5' },
    });
  });

  // The page asked for a network the user has not configured. That is the
  // user's call to make, not the page's, so it surfaces as a failure.
  it('rejects the promise for a network the wallet does not have', async () => {
    teardown.push(
      bridge(() => ({ status: 'failure', type: 'UNADDED_NETWORK', code: 4001, data: null })),
    );
    const { provider } = await discoverWallet();

    await expect(provider.switchNetwork('nope')).rejects.toBeInstanceOf(GnoConnectError);
  });
});
