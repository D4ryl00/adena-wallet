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

import {
  answerSessionMessage,
  createReplayMemory,
  ReplayMemory,
  SessionDeps,
  SessionMessageData,
  SessionReviewRequest,
  toSessionReply,
} from '@inject/message/methods/gno-connect-session';

import { announceGnoWallet } from './announce';
import { GnoConnectError } from './response';
import { buildTransactionParams } from './tx-builder';
import {
  GNO_REGISTER_WALLET_EVENT,
  GNO_REQUEST_WALLET_EVENT,
  GnoConnectOptions,
  GnoDisconnectRequest,
  GnoWalletAnnouncement,
  UserResponse,
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

/** One message: what varies from one MsgCall to the next inside a transaction. */
const MSG = {
  path: 'gno.land/r/demo/boards',
  func: 'CreateThread',
  args: [{ name: 'bid', value: '2' }],
};

const INTENT = {
  ...MSG,
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
      args: { address: 'g1abc', chainid: 'dev', pubkey: 'pub', features: ['sendtx', 'signtx', 'multi_msg', 'sessions', 'challenge'] },
    });
    expect(seenRequests).toEqual(['ADD_ESTABLISH', 'GET_ACCOUNT']);
  });

  it('connects with a challenge: signs it through SignArbitrary and answers the proof', async () => {
    const seenRequests: string[] = [];
    teardown.push(
      bridge((request) => {
        seenRequests.push(request.type);
        if (request.type === 'ADD_ESTABLISH') return { status: 'success', type: 'CONNECTION_SUCCESS', data: {} };
        if (request.type === 'GET_NETWORK') {
          return { status: 'success', type: 'GET_NETWORK', data: { chainId: 'dev', rpcUrl: 'http://127.0.0.1:26657' } };
        }
        if (request.type === 'GET_ACCOUNT') {
          return { status: 'success', type: 'GET_ACCOUNT', data: { address: 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5' } };
        }
        return {
          status: 'success',
          type: 'SIGN_ARBITRARY',
          data: {
            signed: { chain_id: 'dev' },
            signature: {
              pubKey: { typeUrl: '/tm.PubKeySecp256k1', value: 'A+FhNtsXHjLfSJk1lB8FbiL4mGPjc50Kt81J7EKDnJ2y' },
              signature: 'c2ln',
            },
          },
        };
      }),
    );
    const { provider } = await discoverWallet();

    const answer = await provider.connect({ challenge: 'example.com: prove it', chainid: 'dev' });
    expect(seenRequests).toEqual(['ADD_ESTABLISH', 'GET_NETWORK', 'GET_ACCOUNT', 'SIGN_ARBITRARY']);
    expect(answer).toMatchObject({
      status: 'Approved',
      args: {
        address: 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5',
        chainid: 'dev',
        proof: { signed: { chain_id: 'dev' }, signature: 'c2ln' },
      },
    });
    expect((answer as { args: { pubkey: string } }).args.pubkey).toMatch(/^gpub1/);
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

    await expect(
      provider.sendMsgs({ msgs: [MSG, MSG], chainid: ACTIVE_CHAIN_ID }),
    ).resolves.toEqual({
      status: 'Approved',
      args: { hash: 'multi' },
    });
  });

  // A batch carries the chain and the signer once, on the transaction, so there
  // is no way to write two of either. This is the shape doing the work: the old
  // array of full intents let a page name two chains in one broadcast, and every
  // wallet answered that differently.
  it('refuses a batch with no messages', async () => {
    teardown.push(bridge(onConnectedWallet(() => ({}))));
    const { provider } = await discoverWallet();

    await expect(
      provider.sendMsgs({ msgs: [], chainid: ACTIVE_CHAIN_ID }),
    ).rejects.toThrow(/No transaction intent/);
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

  // A batch names its chain once, on the transaction. Falling back to the page's
  // declaration works the same as for a single intent.
  it('resolves a batch chain from the page when the request names none', async () => {
    document.head.innerHTML = `<meta name="gnoconnect:chainid" content="${ACTIVE_CHAIN_ID}" />`;
    teardown.push(
      bridge(onConnectedWallet(() => ({ status: 'success', type: 'TRANSACTION_SUCCESS', data: { hash: 'meta' } }))),
    );
    const { provider } = await discoverWallet();

    await expect(provider.sendMsgs({ msgs: [MSG] })).resolves.toEqual({
      status: 'Approved',
      args: { hash: 'meta' },
    });
    document.head.innerHTML = '';
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

// Sessions: the provider, the executor and the real background handler, with the
// wallet's storage, chain and review window replaced by `deps`.
describe('GnoConnect sessions, end to end', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ec: EC } = require('elliptic');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sha256, toBech32 } = require('adena-module');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { canonicalPayload, decodeGpub } = require('./session-request');
  const sessionMethods = { answerSessionMessage, createReplayMemory, toSessionReply };

  const IDENTITY = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';
  const NOW = 1790841600;
  const secp = new EC('secp256k1');

  function newKey(seed: string): { gpub: string; address: string; sign: (d: Uint8Array) => Uint8Array } {
    const kp = secp.keyFromPrivate(seed.repeat(32));
    const pub: number[] = kp.getPublic(true, 'array');
    const url = Array.from(new TextEncoder().encode('/tm.PubKeySecp256k1'));
    const inner = [0x0a, pub.length, ...pub];
    const gpub = toBech32('gpub', Uint8Array.from([0x0a, url.length, ...url, 0x12, inner.length, ...inner]), Infinity);
    return {
      gpub,
      address: decodeGpub(gpub).address,
      sign: (d): Uint8Array => {
        const s = kp.sign(Array.from(sha256(d)), { canonical: true });
        return Uint8Array.from([...s.r.toArray('be', 32), ...s.s.toArray('be', 32)]);
      },
    };
  }

  const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

  type SignedRequest = GnoConnectOptions & GnoDisconnectRequest;

  function signed(host: 'connect' | 'disconnect', fields: Record<string, unknown>, key = newKey('01')): SignedRequest {
    const data = new TextEncoder().encode(canonicalPayload(host, { ...fields, sig: '' }));
    return { ...fields, sig: b64url(key.sign(data)) } as unknown as SignedRequest;
  }

  const KEY = newKey('01');
  const grantFields = (state = 's1'): Record<string, unknown> => ({
    pubkey: KEY.gpub,
    allow: ['vm/exec:gno.land/r/demo/game'],
    spend: '5000000ugnot',
    period: 3600,
    expires: 86400,
    chainid: ACTIVE_CHAIN_ID,
    state,
    iat: NOW,
  });
  const disconnectFields = (state = 'd1'): Record<string, unknown> => ({
    pubkey: KEY.gpub,
    chainid: ACTIVE_CHAIN_ID,
    signer: IDENTITY,
    state,
    iat: NOW,
  });

  type Session = { expiresAt: number; allow: string[]; spend: string; period: number };

  interface FakeWallet {
    state: {
      established: boolean;
      sessions: Map<string, Session>;
      reviews: SessionReviewRequest[];
      withdrawals: number;
      reviewAnswer: unknown;
      /** Runs when the review opens: what the user's transaction does on chain. */
      onReview: () => void;
      /** Reads of the chain the background left until the effect shows. */
      waits: number;
      isSession: boolean;
    };
    deps: SessionDeps;
    memory: ReplayMemory;
  }

  function wallet(): FakeWallet {
    const state: FakeWallet['state'] = {
      established: true,
      sessions: new Map<string, Session>(),
      reviews: [],
      withdrawals: 0,
      reviewAnswer: { status: 'Rejected' } as unknown,
      onReview: (): void => undefined,
      waits: 0,
      isSession: false,
    };
    const deps: SessionDeps = {
      origin: 'http://localhost',
      isEstablished: async () => state.established,
      withdrawApproval: async (): Promise<void> => {
        state.withdrawals++;
        state.established = false;
      },
      network: async () => ({ chainId: ACTIVE_CHAIN_ID, rpcUrl: ACTIVE_RPC_URL }),
      identity: async () => ({ address: IDENTITY, pubkey: 'gpub1identity', isSession: state.isSession }),
      getSession: async (_master: string, address: string) => state.sessions.get(address) ?? null,
      countSessions: async () => state.sessions.size,
      chainNow: async () => NOW,
      clock: () => NOW,
      review: async (request: SessionReviewRequest): Promise<UserResponse<unknown>> => {
        state.reviews.push(request);
        state.onReview();
        return state.reviewAnswer as UserResponse<unknown>;
      },
      wait: async (): Promise<void> => {
        state.waits++;
      },
    };
    return { state, deps, memory: sessionMethods.createReplayMemory() };
  }

  /** The background: session messages go to the real handler, the rest to `other`. */
  type Request = { type: string; data: SessionMessageData };

  const nothing = (): Record<string, unknown> => ({});

  function sessionBridge(w: FakeWallet, other: (request: Request) => Record<string, unknown> = nothing): () => void {
    return bridgeAsync(async (request) => {
      if (String(request.type).startsWith('GNOCONNECT_SESSION_')) {
        return sessionMethods.toSessionReply(
          await sessionMethods.answerSessionMessage(w.deps, w.memory, request.type, request.data),
        );
      }
      return onConnectedWallet(other)(request);
    });
  }

  /** `bridge`, for a reply that is computed asynchronously. */
  function bridgeAsync(reply: (request: Request) => Promise<Record<string, unknown>>): () => void {
    const spy = jest.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      const request = message as Record<string, unknown>;
      if (request?.status !== 'request') return;
      setTimeout(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { ...request, ...(await reply(request as unknown as Request)) },
            origin: window.location.origin,
          }),
        );
      }, 0);
    });
    return (): void => spy.mockRestore();
  }

  let teardown: (() => void)[] = [];
  afterEach(() => {
    teardown.forEach((fn) => fn());
    teardown = [];
  });

  it('refuses a bad proof with invalid_proof before any window', async () => {
    const w = wallet();
    const seen: string[] = [];
    teardown.push(sessionBridge(w, (r) => (seen.push(r.type), {})));
    const { provider } = await discoverWallet();

    const req = signed('connect', grantFields());
    await expect(provider.connect({ ...req, spend: '9000000ugnot' })).resolves.toEqual({
      status: 'Rejected',
      code: 'invalid_proof',
    });
    expect(w.state.reviews).toHaveLength(0);
    expect(seen).not.toContain('ADD_ESTABLISH');
  });

  it('refuses a stale request with stale_request', async () => {
    const w = wallet();
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.connect(signed('connect', { ...grantFields(), iat: NOW - 660 }))).resolves.toEqual({
      status: 'Rejected',
      code: 'stale_request',
    });
  });

  it('opens the review for a new grant and answers the grant', async () => {
    const w = wallet();
    w.state.reviewAnswer = {
      status: 'Approved',
      args: { session: KEY.address, expiresAt: NOW + 86400, allow: ['vm/exec:gno.land/r/demo/game'], spend: '5000000ugnot', period: 3600, hash: 'h1' },
    };
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    const answer = await provider.connect(signed('connect', grantFields()));
    expect(w.state.reviews).toHaveLength(1);
    expect(w.state.reviews[0]).toMatchObject({ host: 'connect', origin: 'http://localhost', identity: IDENTITY, onChainOld: false });
    expect(answer).toEqual({
      status: 'Approved',
      args: {
        address: IDENTITY, chainid: ACTIVE_CHAIN_ID, pubkey: 'gpub1identity', features: ['sendtx', 'signtx', 'multi_msg', 'sessions', 'challenge'],
        session: KEY.address, expiresAt: NOW + 86400, allow: ['vm/exec:gno.land/r/demo/game'], spend: '5000000ugnot', period: 3600, hash: 'h1',
      },
    });
  });

  it('answers a live session from the chain, without a window', async () => {
    const w = wallet();
    w.state.sessions.set(KEY.address, { expiresAt: NOW + 100, allow: ['bank/send'], spend: '1ugnot', period: 0 });
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    const answer = await provider.connect(signed('connect', grantFields()));
    expect(w.state.reviews).toHaveLength(0);
    expect(answer).toMatchObject({
      status: 'Approved',
      args: { address: IDENTITY, session: KEY.address, expiresAt: NOW + 100, allow: ['bank/send'], spend: '1ugnot', period: 0 },
    });
  });

  // The user closed the review after the transaction left: the chain answers.
  const CLOSED_AFTER_SEND = { closedAfterSend: true };
  const GRANTED: Session = { expiresAt: NOW + 86400, allow: ['vm/exec:gno.land/r/demo/game'], spend: '5000000ugnot', period: 3600 };

  it('answers a grant from the chain when the review closes after sending it', async () => {
    const w = wallet();
    w.state.reviewAnswer = CLOSED_AFTER_SEND;
    // The effect shows on the node a few reads later.
    const getSession = w.deps.getSession;
    w.deps.getSession = async (master, address): Promise<Session | null> => {
      if (w.state.reviews.length > 0 && w.state.waits === 2) w.state.sessions.set(KEY.address, GRANTED);
      return getSession(master, address);
    };
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.connect(signed('connect', grantFields()))).resolves.toEqual({
      status: 'Approved',
      args: {
        address: IDENTITY, chainid: ACTIVE_CHAIN_ID, pubkey: 'gpub1identity', features: ['sendtx', 'signtx', 'multi_msg', 'sessions', 'challenge'],
        session: KEY.address, ...GRANTED,
      },
    });
  });

  it('answers tx_failed when the review closes after sending and nothing ever shows', async () => {
    const w = wallet();
    w.state.reviewAnswer = CLOSED_AFTER_SEND;
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.connect(signed('connect', grantFields()))).rejects.toMatchObject({ code: 'tx_failed' });
    expect(w.state.waits).toBeGreaterThan(0);
  });

  it('answers a revocation from the chain when the review closes after sending it', async () => {
    const w = wallet();
    w.state.sessions.set(KEY.address, GRANTED);
    w.state.reviewAnswer = CLOSED_AFTER_SEND;
    w.state.onReview = (): void => {
      w.state.sessions.delete(KEY.address);
    };
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.disconnect(signed('disconnect', disconnectFields()))).resolves.toEqual({
      status: 'Approved',
      args: { revoked: KEY.address },
    });
  });

  it('reads the old key revoked in the same transaction into the answer', async () => {
    const w = wallet();
    const OLD = newKey('02');
    w.state.sessions.set(OLD.address, GRANTED);
    w.state.reviewAnswer = CLOSED_AFTER_SEND;
    w.state.onReview = (): void => {
      w.state.sessions.delete(OLD.address);
      w.state.sessions.set(KEY.address, GRANTED);
    };
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    const fields = { ...grantFields(), old: OLD.gpub, signer: IDENTITY };
    const data = new TextEncoder().encode(canonicalPayload('connect', { ...fields, sig: '' }));
    const req = { ...fields, sig: b64url(KEY.sign(data)), oldsig: b64url(OLD.sign(data)) } as unknown as SignedRequest;
    await expect(provider.connect(req)).resolves.toMatchObject({
      status: 'Approved',
      args: { session: KEY.address, revoked: OLD.address },
    });
  });

  it('answers session_expired for an expired session', async () => {
    const w = wallet();
    w.state.sessions.set(KEY.address, { expiresAt: NOW - 1, allow: ['bank/send'], spend: '', period: 0 });
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.connect(signed('connect', grantFields()))).resolves.toEqual({ status: 'Rejected', code: 'session_expired' });
  });

  it('answers session_limit when the identity has 16 sessions', async () => {
    const w = wallet();
    for (let i = 0; i < 16; i++) w.state.sessions.set(`g1other${i}`, { expiresAt: NOW + 1, allow: ['*'], spend: '', period: 0 });
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.connect(signed('connect', grantFields()))).resolves.toEqual({ status: 'Rejected', code: 'session_limit' });
    expect(w.state.reviews).toHaveLength(0);
  });

  it('answers signer_unavailable when the active account is itself a session', async () => {
    const w = wallet();
    w.state.isSession = true;
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.connect(signed('connect', grantFields()))).resolves.toEqual({ status: 'Rejected', code: 'signer_unavailable' });
  });

  it('ignores a repeated (pubkey, state): no second window', async () => {
    const w = wallet();
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    const req = signed('connect', grantFields('same'));
    await provider.connect(req);
    await expect(provider.connect(req)).resolves.toEqual({ status: 'Rejected', code: 'invalid_request' });
    expect(w.state.reviews).toHaveLength(1);
  });

  it('keeps connect() and connect(hints) as they were, and lists sessions in features', async () => {
    const w = wallet();
    teardown.push(
      sessionBridge(w, (r) =>
        r.type === 'GET_ACCOUNT'
          ? { status: 'success', type: 'GET_ACCOUNT', data: { address: 'g1abc', chainId: 'dev', publicKey: { value: 'pub' } } }
          : {},
      ),
    );
    const { provider } = await discoverWallet();

    const plain = { status: 'Approved', args: { address: 'g1abc', chainid: 'dev', pubkey: 'pub', features: ['sendtx', 'signtx', 'multi_msg', 'sessions', 'challenge'] } };
    await expect(provider.connect()).resolves.toEqual(plain);
    await expect(provider.connect({ allow: ['bank/send'], expires: 3600, chainid: 'dev' })).resolves.toEqual(plain);
    await expect(provider.connect({ allow: ['bank/nope'] })).resolves.toEqual({ status: 'Rejected', code: 'invalid_request' });
  });

  it('disconnect() withdraws the approval and fires disconnect, without a window', async () => {
    const w = wallet();
    teardown.push(
      sessionBridge(w, (r) =>
        r.type === 'GET_ACCOUNT'
          ? { status: 'success', type: 'GET_ACCOUNT', data: { address: IDENTITY, chainId: 'dev', publicKey: null } }
          : {},
      ),
    );
    const { provider } = await discoverWallet();
    const heard = jest.fn();
    provider.on('disconnect', heard);

    await expect(provider.disconnect()).resolves.toEqual({ status: 'Approved', args: {} });
    expect(w.state.withdrawals).toBe(1);
    expect(w.state.reviews).toHaveLength(0);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('disconnect(req) declined in the window is Rejected, and the approval is withdrawn anyway', async () => {
    const w = wallet();
    w.state.sessions.set(KEY.address, { expiresAt: NOW + 100, allow: ['bank/send'], spend: '', period: 0 });
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.disconnect(signed('disconnect', disconnectFields()))).resolves.toEqual({ status: 'Rejected' });
    expect(w.state.reviews).toHaveLength(1);
    expect(w.state.reviews[0]).toMatchObject({ host: 'disconnect' });
    expect(w.state.withdrawals).toBeGreaterThanOrEqual(1);
    expect(w.state.established).toBe(false);
  });

  it('disconnect(req) for a key that is not a session answers session_not_found and withdraws', async () => {
    const w = wallet();
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.disconnect(signed('disconnect', disconnectFields()))).resolves.toEqual({
      status: 'Rejected',
      code: 'session_not_found',
    });
    expect(w.state.reviews).toHaveLength(0);
    expect(w.state.established).toBe(false);
  });

  it('disconnect(req) with a bad proof answers invalid_proof and withdraws', async () => {
    const w = wallet();
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    const req = signed('disconnect', disconnectFields());
    await expect(provider.disconnect({ ...req, state: 'other' })).resolves.toEqual({ status: 'Rejected', code: 'invalid_proof' });
    expect(w.state.established).toBe(false);
  });

  it('disconnect(req) approved answers revoked and hash', async () => {
    const w = wallet();
    w.state.sessions.set(KEY.address, { expiresAt: NOW + 100, allow: ['bank/send'], spend: '', period: 0 });
    w.state.reviewAnswer = { status: 'Approved', args: { revoked: KEY.address, hash: 'h2' } };
    teardown.push(sessionBridge(w));
    const { provider } = await discoverWallet();

    await expect(provider.disconnect(signed('disconnect', disconnectFields()))).resolves.toEqual({
      status: 'Approved',
      args: { revoked: KEY.address, hash: 'h2' },
    });
  });
});
