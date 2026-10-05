import { ChromeLocalStorage } from './chrome-local-storage';

// One `chrome.storage.local` shared by every extension context (background,
// popup), each with its own `ChromeLocalStorage`.
function installChromeStorage(): void {
  const area: Record<string, unknown> = {
    ADENA_DATA: JSON.stringify({ version: 22, data: { ESTABLISH_SITES: {}, CURRENT_ACCOUNT_ID: '' } }),
  };
  const local = {
    get: async (key: string): Promise<Record<string, unknown>> => ({ [key]: area[key] }),
    set: async (items: Record<string, unknown>): Promise<void> => {
      Object.assign(area, items);
    },
    remove: async (key: string): Promise<void> => {
      delete area[key];
    },
    clear: async (): Promise<void> => {
      Object.keys(area).forEach((k) => delete area[k]);
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local } };
}

describe('ChromeLocalStorage across contexts', () => {
  beforeEach(installChromeStorage);

  it('reads what another context wrote after its own first write', async () => {
    const background = new ChromeLocalStorage();
    const popup = new ChromeLocalStorage();

    await background.set('ESTABLISH_SITES', { a: [] });
    await popup.set('CURRENT_ACCOUNT_ID', 'acc-2');

    expect(await background.get('CURRENT_ACCOUNT_ID')).toBe('acc-2');
  });

  it('keeps what another context wrote when it writes again', async () => {
    const background = new ChromeLocalStorage();
    const popup = new ChromeLocalStorage();

    await background.set('ESTABLISH_SITES', { a: [] });
    await popup.set('CURRENT_ACCOUNT_ID', 'acc-2');
    await background.set('ESTABLISH_SITES', {});

    expect(await new ChromeLocalStorage().get('CURRENT_ACCOUNT_ID')).toBe('acc-2');
  });

  it('keeps both of two writes started together in one context', async () => {
    const background = new ChromeLocalStorage();

    await Promise.all([
      background.set('ESTABLISH_SITES', { a: [] }),
      background.set('CURRENT_ACCOUNT_ID', 'acc-2'),
    ]);

    const fresh = new ChromeLocalStorage();
    expect(await fresh.get('ESTABLISH_SITES')).toEqual({ a: [] });
    expect(await fresh.get('CURRENT_ACCOUNT_ID')).toBe('acc-2');
  });
});
