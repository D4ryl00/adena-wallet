// Stub out `@adena-wallet/sdk` to avoid loading @web3auth's native crypto,
// which fails under jsdom's Uint8Array. Mirrors the setup in `wallet.spec.ts`.
jest.mock('@adena-wallet/sdk', () => ({
  WalletResponseFailureType: { UNEXPECTED_ERROR: 'UNEXPECTED_ERROR' },
  WalletMessageInfo: {
    UNEXPECTED_ERROR: {
      code: 9000,
      status: 'failure',
      type: 'UNEXPECTED_ERROR',
      message: 'Adena could not process the request.',
    },
  },
}));

import { InjectionMessage } from '../message';
import { createPopup } from './common';

describe('createPopup', () => {
  const request = { key: 'k1', hostname: 'localhost', protocol: 'http:', type: 'DO_CONTRACT' } as InjectionMessage;
  const closed = { key: 'k1', status: 'failure', type: 'TRANSACTION_REJECTED' } as unknown as InjectionMessage;

  function installChrome(created: chrome.windows.Window | undefined): void {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (path: string): string => `chrome-extension://id/${path}`, lastError: created ? undefined : { message: 'Invalid value for bounds' } },
      windows: {
        create: (_options: unknown, callback: (window?: chrome.windows.Window) => void): void => callback(created),
        onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
      },
      tabs: { onUpdated: { addListener: jest.fn(), removeListener: jest.fn() } },
    };
  }

  it('answers the page with an unexpected error when the window cannot open', async () => {
    installChrome(undefined);
    const sendResponse = jest.fn();

    await createPopup('/approve', request, closed, sendResponse);

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k1', status: 'failure', type: 'UNEXPECTED_ERROR' }),
    );
  });

  it('does not answer while the window it opened is up', async () => {
    installChrome({ id: 7, tabs: [] } as unknown as chrome.windows.Window);
    const sendResponse = jest.fn();

    await createPopup('/approve', request, closed, sendResponse);

    expect(sendResponse).not.toHaveBeenCalled();
  });
});
