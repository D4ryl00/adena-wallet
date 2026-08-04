// Stub out `@adena-wallet/sdk` to avoid loading @web3auth's native crypto,
// which fails under jsdom's Uint8Array. Mirrors the setup in `wallet.spec.ts`.
jest.mock('@adena-wallet/sdk', () => ({
  WalletResponseStatus: {
    SUCCESS: 'success',
    FAILURE: 'failure',
  },
  WalletResponseFailureType: {
    ALREADY_CONNECTED: 'ALREADY_CONNECTED',
    REDUNDANT_CHANGE_REQUEST: 'REDUNDANT_CHANGE_REQUEST',
    WALLET_LOCKED: 'WALLET_LOCKED',
    NOT_CONNECTED: 'NOT_CONNECTED',
    TRANSACTION_FAILED: 'TRANSACTION_FAILED',
    UNADDED_NETWORK: 'UNADDED_NETWORK',
  },
  WalletResponseRejectType: {
    TRANSACTION_REJECTED: 'TRANSACTION_REJECTED',
    SIGN_REJECTED: 'SIGN_REJECTED',
    CONNECTION_REJECTED: 'CONNECTION_REJECTED',
    SWITCH_NETWORK_REJECTED: 'SWITCH_NETWORK_REJECTED',
    ADD_NETWORK_REJECTED: 'ADD_NETWORK_REJECTED',
  },
}));

import { WalletResponse } from '@adena-wallet/sdk';

import { GnoConnectError, toUserResponse } from './response';

/**
 * The SDK is mocked above, so its enums are plain strings at runtime while tsc
 * still sees the real enum types. Build responses from loose literals and cast
 * once, here, rather than at every call site.
 */
interface ResponseOverrides {
  code?: number;
  status?: string;
  type?: string;
  message?: string;
  data?: unknown;
}

function response(overrides: ResponseOverrides): WalletResponse<any> {
  return {
    code: 0,
    status: 'success',
    type: 'TRANSACTION_SUCCESS',
    message: '',
    data: null,
    ...overrides,
  } as unknown as WalletResponse<any>;
}

describe('toUserResponse', () => {
  it('maps a successful response to Approved, with the extracted payload', () => {
    const result = toUserResponse(
      response({ status: 'success', data: { hash: 'abc123' } }),
      (data) => ({ hash: data.hash }),
    );

    expect(result).toEqual({ status: 'Approved', args: { hash: 'abc123' } });
  });

  // A user declining is an answer, not an error: the promise resolves.
  it.each(['TRANSACTION_REJECTED', 'SIGN_REJECTED', 'CONNECTION_REJECTED'])(
    'maps %s to Rejected rather than throwing',
    (type) => {
      const result = toUserResponse(
        response({ status: 'failure', type, code: 4000 }),
        () => ({}),
      );

      expect(result).toEqual({ status: 'Rejected' });
    },
  );

  // Declining a network change is still an answer, but the standard names the
  // reason — so it rides along as the shared `code` a launch link would carry.
  it.each(['SWITCH_NETWORK_REJECTED', 'ADD_NETWORK_REJECTED'])(
    'maps %s to Rejected with network_declined',
    (type) => {
      const result = toUserResponse(
        response({ status: 'failure', type, code: 4000 }),
        () => ({}),
      );

      expect(result).toEqual({ status: 'Rejected', code: 'network_declined' });
    },
  );

  // Only a genuine failure rejects the promise.
  it.each(['WALLET_LOCKED', 'NOT_CONNECTED', 'TRANSACTION_FAILED', 'UNADDED_NETWORK'])(
    'throws GnoConnectError for %s',
    (type) => {
      expect(() =>
        toUserResponse(response({ status: 'failure', type, code: 4001 }), () => ({})),
      ).toThrow(GnoConnectError);
    },
  );

  it('carries the wallet type, the standard code, and the wallet code', () => {
    try {
      toUserResponse(
        response({
          status: 'failure',
          type: 'WALLET_LOCKED',
          code: 2000,
          message: 'Wallet is locked.',
        }),
        () => ({}),
      );
      fail('expected a GnoConnectError');
    } catch (error) {
      expect(error).toBeInstanceOf(GnoConnectError);
      expect((error as GnoConnectError).type).toBe('WALLET_LOCKED');
      // `code` is the standard's enumerated reason, shared with launch links.
      expect((error as GnoConnectError).code).toBe('no_signer');
      // Adena's own numeric code stays reachable for callers that read it.
      expect((error as GnoConnectError).walletCode).toBe(2000);
      expect((error as GnoConnectError).message).toBe('Wallet is locked.');
    }
  });

  // Every method is gated on an approved origin, so this is the code a page sees
  // first. Not `no_signer`: the wallet may hold plenty of accounts, and on a
  // `getNetwork` that code sends the page looking for the wrong problem.
  it('reports an unapproved origin as not_connected, and says how to fix it', () => {
    try {
      toUserResponse(
        response({ status: 'failure', type: 'NOT_CONNECTED', code: 4000 }),
        () => ({}),
      );
      fail('expected a GnoConnectError');
    } catch (error) {
      expect(error).toBeInstanceOf(GnoConnectError);
      expect((error as GnoConnectError).code).toBe('not_connected');
      expect((error as GnoConnectError).message).toMatch(/connect\(\)/);
    }
  });

  // Anything unmapped is the standard's catch-all, never a wrong specific code.
  it('falls back to tx_failed for an unmapped failure type', () => {
    try {
      toUserResponse(
        response({ status: 'failure', type: 'TRANSACTION_FAILED', code: 4001 }),
        () => ({}),
      );
      fail('expected a GnoConnectError');
    } catch (error) {
      expect((error as GnoConnectError).code).toBe('tx_failed');
    }
  });

  // Adena calls these failures, but each is the state the caller asked for.
  it.each(['ALREADY_CONNECTED', 'REDUNDANT_CHANGE_REQUEST'])(
    'treats %s as Approved',
    (type) => {
      const result = toUserResponse(
        response({ status: 'failure', type, data: { chainId: 'dev' } }),
        (data) => ({ chainid: data?.chainId ?? '' }),
      );

      expect(result).toEqual({ status: 'Approved', args: { chainid: 'dev' } });
    },
  );
});
