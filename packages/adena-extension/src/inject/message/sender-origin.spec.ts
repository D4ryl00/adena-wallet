import { stampSenderOrigin } from './sender-origin';

describe('stampSenderOrigin', () => {
  beforeEach(() => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (path: string): string => `chrome-extension://adena/${path}` },
    };
  });

  const forged = { key: 'k', type: 'DO_CONTRACT', protocol: 'https:', hostname: 'gnoswap.io' };

  it('replaces what the page wrote with the origin the browser saw', () => {
    const sender = { url: 'http://evil.test:8080/app?x=1' } as chrome.runtime.MessageSender;
    expect(stampSenderOrigin(forged, sender)).toEqual({ ...forged, protocol: 'http:', hostname: 'evil.test' });
  });

  it('keeps a request from the extension itself as written', () => {
    const sender = { url: 'chrome-extension://adena/popup.html#/x' } as chrome.runtime.MessageSender;
    expect(stampSenderOrigin(forged, sender)).toBe(forged);
  });

  it('keeps a message without a sender URL as written', () => {
    expect(stampSenderOrigin(forged, {} as chrome.runtime.MessageSender)).toBe(forged);
  });
});
