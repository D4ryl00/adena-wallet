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
    SIGN_TX: 'SIGN_TX',
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
import { buildTransactionParams } from './tx-builder';
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
 * Wraps a reply with the two things every signing request does before anything
 * is built: establish the origin, then read the wallet's active network.
 */
function onConnectedWallet(
  reply: (request: any) => Record<string, unknown>,
): (request: any) => Record<string, unknown> {
  return (request): Record<string, unknown> => {
    if (request.type === 'ADD_ESTABLISH') {
      return { status: 'success', type: 'CONNECTION_SUCCESS', data: {} };
    }
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
    (buildTransactionParams as jest.Mock).mockClear();
  });

  it('lets a page that loaded after the wallet still discover it', async () => {
    const announcement = await discoverWallet();

    expect(announcement.info.rdns).toBe('land.gno.adena');
    expect(typeof announcement.provider.sendTx).toBe('function');
  });

  it('signs and submits, returning Approved with the tx hash', async () => {
    teardown.push(
      bridge(onConnectedWallet(() => ({ status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'deadbeef' } }))),
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
      bridge(onConnectedWallet(() => ({ status: 'failure', type: 'TRANSACTION_REJECTED', code: 4000, data: null }))),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx(INTENT)).resolves.toEqual({
      status: 'Rejected',
    });
  });

  // A genuine failure is not an answer, so it rejects the promise.
  it('rejects the promise when the wallet is locked', async () => {
    teardown.push(
      bridge(onConnectedWallet(() => ({ status: 'failure', type: 'WALLET_LOCKED', code: 2000, data: null }))),
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
      bridge(onConnectedWallet(() => ({ status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'multi' } }))),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTxs([INTENT, INTENT])).resolves.toEqual({
      status: 'Approved',
      args: { hash: 'multi' },
    });
  });

  // Regression: `sendTx` used to assume the origin was already established, so
  // the standard's *core* method silently depended on `connect`, which the
  // standard makes optional. A page implementing only `sendTx` — gnoweb's
  // chooser — got NOT_CONNECTED and no way to act on it.
  it('establishes the origin before signing, without a prior connect()', async () => {
    const seenRequests: string[] = [];
    teardown.push(
      bridge(
        onConnectedWallet((request) => {
          seenRequests.push(request.type);
          return { status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'ok' } };
        }),
      ),
    );
    const { provider } = await discoverWallet();
    // Deliberately no provider.connect() first.
    await expect(provider.sendTx(INTENT)).resolves.toEqual({
      status: 'Approved',
      args: { hash: 'ok' },
    });
    expect(seenRequests).toEqual(['DO_CONTRACT']);
  });

  // Establishing is unconditional, so a site the wallet already knows must not
  // be turned away: ALREADY_CONNECTED is the state the caller asked for.
  it('treats an already-connected site as established', async () => {
    teardown.push(
      bridge((request) => {
        if (request.type === 'ADD_ESTABLISH') {
          return { status: 'failure', type: 'ALREADY_CONNECTED', code: 4001, data: null };
        }
        if (request.type === 'GET_NETWORK') {
          return {
            status: 'success',
            type: 'GET_NETWORK',
            data: { chainId: ACTIVE_CHAIN_ID, rpcUrl: ACTIVE_RPC_URL, networkName: 'Local' },
          };
        }
        return { status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'again' } };
      }),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx(INTENT)).resolves.toEqual({
      status: 'Approved',
      args: { hash: 'again' },
    });
  });

  // chainid selects the network. Without one there is nothing to select, and
  // "whichever chain the wallet happens to be on" is how a dapp built for one
  // chain gets a signature valid on another.
  it('refuses a request that names no chain', async () => {
    teardown.push(bridge(onConnectedWallet(() => ({}))));
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
        if (request.type === 'ADD_ESTABLISH') {
          return { status: 'success', type: 'CONNECTION_SUCCESS', data: {} };
        }
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
        onConnectedWallet(() => ({
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
        onConnectedWallet((request) => {
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

  // The pin is checked here *and* carried into the request, because this check
  // runs in the page world before the approval screen exists — the account it
  // sees is not necessarily the one that ends up signing.
  it('carries the pinned signer through to the approval screen', async () => {
    teardown.push(
      bridge(
        onConnectedWallet((request) => {
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

    await provider.sendTx({ ...INTENT, signer: 'g1abc' });

    // (intents, network, declaredRpcUrl, signer)
    expect(buildTransactionParams).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      'g1abc',
    );
  });

  // Nothing to carry when the request pinned nothing: an absent `signer` must
  // not reach the approval screen as a pin it then fails to satisfy.
  it('carries no signer when the request pinned none', async () => {
    teardown.push(
      bridge(onConnectedWallet(() => ({ status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'ok' } }))),
    );
    const { provider } = await discoverWallet();

    await provider.sendTx(INTENT);

    expect(buildTransactionParams).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
    );
  });

  // Checked before the switch prompt: a request that cannot be signed as the
  // pinned account fails either way, so prompting for a network switch first
  // asks the user to answer a question that changes nothing.
  it('fails a pinned signer without first prompting for a network switch', async () => {
    const seenRequests: string[] = [];
    teardown.push(
      bridge((request) => {
        seenRequests.push(request.type);
        if (request.type === 'ADD_ESTABLISH') {
          return { status: 'success', type: 'CONNECTION_SUCCESS', data: {} };
        }
        if (request.type === 'GET_NETWORK') {
          return {
            status: 'success',
            type: 'GET_NETWORK',
            data: { chainId: ACTIVE_CHAIN_ID, rpcUrl: ACTIVE_RPC_URL, networkName: 'Local' },
          };
        }
        return {
          status: 'success',
          type: 'GET_ACCOUNT',
          data: { address: 'g1someoneelse', chainId: 'dev', publicKey: { value: 'pub' } },
        };
      }),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendTx({ ...INTENT, signer: 'g1abc' })).rejects.toMatchObject({
      code: 'signer_unavailable',
    });
    expect(seenRequests).not.toContain('SWITCH_NETWORK');
  });

  // One transaction lands on one chain. Messages naming different chains
  // describe something that cannot be signed, and picking one of them silently
  // would sign the others against a chain they never named.
  it('refuses a batch whose messages name different chains', async () => {
    teardown.push(bridge(onConnectedWallet(() => ({}))));
    const { provider } = await discoverWallet();

    await expect(
      provider.sendTxs([INTENT, { ...INTENT, chainid: 'test5' }]),
    ).rejects.toThrow(/same chainid/);
  });

  it('signs without broadcasting, returning the encoded transaction', async () => {
    teardown.push(
      bridge(
        onConnectedWallet(() => ({
          status: 'success',
          type: 'SIGN_SUCCESS',
          data: { encodedTransaction: 'CgoKCC92bS5tX2M=' },
        })),
      ),
    );
    const { provider } = await discoverWallet();

    await expect(provider.signTx(INTENT)).resolves.toEqual({
      status: 'Approved',
      args: { signedtx: 'CgoKCC92bS5tX2M=' },
    });
  });

  it('routes signTx through the sign handler, never the broadcast one', async () => {
    const seenRequests: string[] = [];
    teardown.push(
      bridge(
        onConnectedWallet((request) => {
          seenRequests.push(request.type);
          return {
            status: 'success',
            type: 'SIGN_SUCCESS',
            data: { encodedTransaction: 'signed' },
          };
        }),
      ),
    );
    const { provider } = await discoverWallet();

    await provider.signTx(INTENT);

    expect(seenRequests).toEqual(['SIGN_TX']);
  });

  // signTx resolves the network the same way sendTx does — a sign-only request
  // is still a request to sign for one specific chain.
  it('declines signTx when the user refuses to switch to the requested chain', async () => {
    teardown.push(
      bridge((request) => {
        if (request.type === 'ADD_ESTABLISH') {
          return { status: 'success', type: 'CONNECTION_SUCCESS', data: {} };
        }
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

    await expect(provider.signTx(INTENT)).rejects.toMatchObject({
      code: 'network_declined',
    });
  });

  it('resolves signTx as Rejected when the user declines to sign', async () => {
    teardown.push(
      bridge(onConnectedWallet(() => ({ status: 'failure', type: 'SIGN_REJECTED', code: 4000, data: null }))),
    );
    const { provider } = await discoverWallet();

    await expect(provider.signTx(INTENT)).resolves.toEqual({ status: 'Rejected' });
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
