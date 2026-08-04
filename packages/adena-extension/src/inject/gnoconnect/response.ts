import {
  WalletResponse,
  WalletResponseFailureType,
  WalletResponseRejectType,
  WalletResponseStatus,
} from '@adena-wallet/sdk';

import { GnoErrorCode, UserResponse } from './types';

/**
 * The user declining is an answer — a resolved `Rejected` — and anything else is
 * a genuine failure that rejects the promise. Keyed on the reject-type enum, not
 * on `code`, so a new SDK failure type surfaces as a throw and never as a silent
 * "the user said no".
 */
const REJECT_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(WalletResponseRejectType),
);

/** `ALREADY_CONNECTED` is a failure in Adena's vocabulary but a success here. */
const BENIGN_FAILURE_TYPES: ReadonlySet<string> = new Set<string>([
  WalletResponseFailureType.ALREADY_CONNECTED,
  WalletResponseFailureType.REDUNDANT_CHANGE_REQUEST,
]);

/**
 * Adena's failure types on the standard's codes. Anything unmapped is
 * `tx_failed`: a wrong specific code is worse than an honest general one.
 */
const ERROR_CODES: Readonly<Record<string, GnoErrorCode>> = {
  [WalletResponseFailureType.INVALID_FORMAT]: 'invalid_request',
  [WalletResponseFailureType.UNADDED_NETWORK]: 'network_declined',
  [WalletResponseFailureType.NOT_INITIALIZED_NETWORK]: 'network_declined',
  [WalletResponseFailureType.UNSUPPORTED_TYPE]: 'unsupported_host',
  [WalletResponseFailureType.NO_ACCOUNT]: 'no_signer',
  [WalletResponseFailureType.WALLET_LOCKED]: 'no_signer',
  // Not `no_signer`: the wallet may hold plenty of accounts, it just has no
  // agreement to talk to this origin.
  [WalletResponseFailureType.NOT_CONNECTED]: 'not_connected',
  [WalletResponseFailureType.ACCOUNT_MISMATCH]: 'signer_unavailable',
  // A declined switch or add is the user's answer, so it reaches the page as a
  // Rejected response — but it still carries a reason.
  [WalletResponseRejectType.SWITCH_NETWORK_REJECTED]: 'network_declined',
  [WalletResponseRejectType.ADD_NETWORK_REJECTED]: 'network_declined',
};

export function toErrorCode(type: unknown): GnoErrorCode {
  return ERROR_CODES[String(type)] ?? 'tx_failed';
}

/** The reason on a `Rejected`, when Adena named one. Absent for a plain decline. */
function toRejectCode(type: unknown): GnoErrorCode | undefined {
  return ERROR_CODES[String(type)];
}

/** Failures whose code says what happened but not what to do about it. */
const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  [WalletResponseFailureType.NOT_CONNECTED]:
    'This site is not connected to the wallet. Call connect() and retry.',
};

export class GnoConnectError extends Error {
  public readonly type: string;
  /** The standard's enumerated reason. */
  public readonly code: GnoErrorCode;
  /** Adena's own numeric code, kept for callers that already read it. */
  public readonly walletCode: number;

  constructor(response: WalletResponse<unknown>) {
    super(
      FAILURE_MESSAGES[String(response.type)] ||
        response.message ||
        `GnoConnect request failed: ${response.type}`,
    );
    this.name = 'GnoConnectError';
    this.type = String(response.type);
    this.code = toErrorCode(response.type);
    this.walletCode = response.code;
  }
}

export { GnoConnectRequestError } from './errors';

/** @param extract builds the `args` payload from a successful response. */
export function toUserResponse<D, T>(
  response: WalletResponse<D>,
  extract: (data: D) => T,
): UserResponse<T> {
  const isSuccess =
    response.status === WalletResponseStatus.SUCCESS ||
    BENIGN_FAILURE_TYPES.has(String(response.type));

  if (isSuccess) {
    return { status: 'Approved', args: extract(response.data as D) };
  }

  if (REJECT_TYPES.has(String(response.type))) {
    const code = toRejectCode(response.type);
    return code ? { status: 'Rejected', code } : { status: 'Rejected' };
  }

  throw new GnoConnectError(response);
}
