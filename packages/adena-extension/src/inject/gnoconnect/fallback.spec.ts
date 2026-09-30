import { installNoScriptFallback, isTxSource, parseTxForm, parseTxLink } from './fallback';
import { GNO_REQUEST_WALLET_EVENT } from './types';

// The fallback reaches the wallet through an injected `send`; tests record it.
const mockSendTx = jest.fn();

function setMeta(name: string, content: string | null): void {
  document.head.querySelector(`meta[name="${name}"]`)?.remove();
  if (content !== null) {
    const meta = document.createElement('meta');
    meta.name = name;
    meta.content = content;
    document.head.appendChild(meta);
  }
}

function gnowebForm(action: string, fields: Record<string, string>): HTMLFormElement {
  const form = document.createElement('form');
  form.method = 'GET';
  form.action = action;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  return form;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('parseTxLink', () => {
  it('reads a relative gnoweb TxLink as named arguments', () => {
    expect(parseTxLink('/r/demo/boards$help&func=CreateThread&bid=2&title=hello%20world')).toEqual({
      path: 'gno.land/r/demo/boards',
      func: 'CreateThread',
      args: [
        { name: 'bid', value: '2' },
        { name: 'title', value: 'hello world' },
      ],
    });
  });

  it('takes `.send` as coins and ignores other webargs', () => {
    expect(
      parseTxLink('https://gno.land/r/demo/foo$help&func=Pay&.send=10ugnot&.max_deposit=1ugnot'),
    ).toEqual({
      path: 'gno.land/r/demo/foo',
      func: 'Pay',
      args: [],
      send: '10ugnot',
    });
  });

  it('rejects what is not a TxLink', () => {
    expect(parseTxLink('/r/demo/foo')).toBeNull();
    expect(parseTxLink('/r/demo/foo$help')).toBeNull();
    expect(parseTxLink('/$help&func=Foo')).toBeNull();
    expect(parseTxLink('/r/demo/foo$help&func=Foo&a=%E0%A4%A')).toBeNull();
  });
});

describe('parseTxForm', () => {
  it('fills the action TxLink from the submitted fields', () => {
    const form = gnowebForm('/r/demo/foo$help&func=Bar&a=&b=kept', { func: 'Bar', a: '1', c: '3' });
    expect(parseTxForm(form)).toEqual({
      path: 'gno.land/r/demo/foo',
      func: 'Bar',
      args: [
        { name: 'a', value: '1' },
        { name: 'b', value: 'kept' },
        { name: 'c', value: '3' },
      ],
    });
  });

  it('refuses a func field naming another function, and a POST', () => {
    expect(parseTxForm(gnowebForm('/r/demo/foo$help&func=Bar', { func: 'Other' }))).toBeNull();

    const post = gnowebForm('/r/demo/foo$help&func=Bar', {});
    post.method = 'POST';
    expect(parseTxForm(post)).toBeNull();
  });
});

describe('isTxSource', () => {
  afterEach(() => setMeta('gnoconnect:txdomains', null));

  it('allows only the page origin when no txdomains is declared', () => {
    expect(isTxSource('/r/demo/foo$help&func=Bar')).toBe(true);
    expect(isTxSource('https://evil.example/r/demo/foo$help&func=Bar')).toBe(false);
  });

  it('honours auto and listed domains', () => {
    setMeta('gnoconnect:txdomains', 'auto, gno.land');
    expect(isTxSource('/r/demo/foo$help&func=Bar')).toBe(true);
    expect(isTxSource('https://gno.land/r/demo/foo$help&func=Bar')).toBe(true);
    expect(isTxSource('https://evil.example/r/demo/foo$help&func=Bar')).toBe(false);
  });
});

// One install for the file, and the page asking is final, so the test that asks runs last.
describe('installNoScriptFallback', () => {
  beforeAll(() => installNoScriptFallback(window, mockSendTx));

  beforeEach(() => {
    mockSendTx.mockReset().mockResolvedValue({ status: 'Approved', args: { hash: 'h' } });
    setMeta('gnoconnect:chainid', 'dev');
    document.body.innerHTML = '';
  });

  function clickLink(href: string, init: MouseEventInit = {}): MouseEvent {
    const anchor = document.createElement('a');
    anchor.href = href;
    document.body.appendChild(anchor);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    anchor.dispatchEvent(event);
    return event;
  }

  function submit(form: HTMLFormElement): Event {
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    return event;
  }

  it('takes a TxLink click and sends it as a sendTx without signer', () => {
    const event = clickLink('/r/demo/foo$help&func=Bar&a=1');
    expect(event.defaultPrevented).toBe(true);
    expect(mockSendTx).toHaveBeenCalledWith({
      path: 'gno.land/r/demo/foo',
      func: 'Bar',
      args: [{ name: 'a', value: '1' }],
    });
  });

  it('leaves ordinary links, modified clicks and off-origin TxLinks alone', () => {
    expect(clickLink('/r/demo/foo').defaultPrevented).toBe(false);
    expect(clickLink('/r/demo/foo$help&func=Bar', { metaKey: true }).defaultPrevented).toBe(false);
    expect(clickLink('https://evil.example/r/demo/foo$help&func=Bar').defaultPrevented).toBe(false);
    expect(mockSendTx).not.toHaveBeenCalled();
  });

  it('stays out of a page that declares no chain', () => {
    setMeta('gnoconnect:chainid', null);
    expect(clickLink('/r/demo/foo$help&func=Bar').defaultPrevented).toBe(false);
  });

  it('takes the Execute submit', () => {
    const event = submit(gnowebForm('/r/demo/foo$help&func=Bar&a=', { func: 'Bar', a: '7' }));
    expect(event.defaultPrevented).toBe(true);
    expect(mockSendTx).toHaveBeenCalledWith({
      path: 'gno.land/r/demo/foo',
      func: 'Bar',
      args: [{ name: 'a', value: '7' }],
    });
  });

  it('lets the navigation through when the wallet cannot carry the request', async () => {
    mockSendTx.mockRejectedValue(Object.assign(new Error('bad'), { code: 'invalid_request' }));
    const form = gnowebForm('/r/demo/foo$help&func=Bar', {});
    const proceed = jest.spyOn(form, 'submit').mockImplementation(() => undefined);
    submit(form);
    await flush();
    expect(proceed).toHaveBeenCalled();
  });

  it('keeps the user where they were when they declined', async () => {
    mockSendTx.mockRejectedValue(Object.assign(new Error('no'), { code: 'network_declined' }));
    const form = gnowebForm('/r/demo/foo$help&func=Bar', {});
    const proceed = jest.spyOn(form, 'submit').mockImplementation(() => undefined);
    submit(form);
    await flush();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('stands down for good once the page asks for wallets', () => {
    window.dispatchEvent(new Event(GNO_REQUEST_WALLET_EVENT));
    expect(clickLink('/r/demo/foo$help&func=Bar').defaultPrevented).toBe(false);
    expect(submit(gnowebForm('/r/demo/foo$help&func=Bar', {})).defaultPrevented).toBe(false);
    expect(mockSendTx).not.toHaveBeenCalled();
  });
});
