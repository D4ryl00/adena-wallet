import { GnoErrorCode } from './types';

/**
 * A failure the wallet can name without asking the user — a malformed request,
 * a chain it does not have, a `signer` it cannot be.
 *
 * Deliberately free of `@adena-wallet/sdk`: this is the standard's vocabulary,
 * and the tx builder raises it while resolving arguments. Keeping the SDK out
 * means the builder can be tested without loading @web3auth's native crypto,
 * which does not run under jsdom.
 */
export class GnoConnectRequestError extends Error {
  public readonly code: GnoErrorCode;

  constructor(code: GnoErrorCode, message: string) {
    super(message);
    this.name = 'GnoConnectRequestError';
    this.code = code;
  }
}
