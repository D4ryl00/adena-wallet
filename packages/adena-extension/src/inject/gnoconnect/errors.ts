import { GnoErrorCode } from './types';

// Kept free of @adena-wallet/sdk so the tx builder, which raises this, can be
// tested without loading @web3auth's native crypto (which fails under jsdom).
export class GnoConnectRequestError extends Error {
  public readonly code: GnoErrorCode;

  constructor(code: GnoErrorCode, message: string) {
    super(message);
    this.name = 'GnoConnectRequestError';
    this.code = code;
  }
}
