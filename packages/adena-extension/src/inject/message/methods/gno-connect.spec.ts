import { normalizeGnoConnectRpc, parseGnoConnectChainId } from './gno-connect';

describe('normalizeGnoConnectRpc', () => {
  it('keeps http(s) endpoints as-is', () => {
    expect(normalizeGnoConnectRpc('https://rpc.gno.land')).toBe('https://rpc.gno.land');
    expect(normalizeGnoConnectRpc('http://127.0.0.1:26657')).toBe('http://127.0.0.1:26657');
  });

  it('maps a non-http scheme on a loopback host to http://', () => {
    // Local gno nodes commonly advertise their RPC as tcp://; downstream RPC
    // clients require http(s), so it must be rewritten rather than stripped bare.
    expect(normalizeGnoConnectRpc('tcp://127.0.0.1:26657')).toBe('http://127.0.0.1:26657');
    expect(normalizeGnoConnectRpc('tcp://localhost:26657')).toBe('http://localhost:26657');
  });

  it('adds a protocol to a bare loopback host', () => {
    expect(normalizeGnoConnectRpc('127.0.0.1:26657')).toBe('http://127.0.0.1:26657');
  });

  it('assumes https for non-loopback hosts missing a protocol', () => {
    expect(normalizeGnoConnectRpc('tcp://rpc.gno.land')).toBe('https://rpc.gno.land');
    expect(normalizeGnoConnectRpc('rpc.gno.land')).toBe('https://rpc.gno.land');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeGnoConnectRpc('  http://127.0.0.1:26657  ')).toBe('http://127.0.0.1:26657');
  });

  it('returns an empty string unchanged', () => {
    expect(normalizeGnoConnectRpc('')).toBe('');
    expect(normalizeGnoConnectRpc('   ')).toBe('');
  });
});

describe('parseGnoConnectChainId', () => {
  afterEach(() => {
    document.head.innerHTML = '';
  });

  const declare = (html: string): void => {
    document.head.innerHTML = html;
  };

  it('reads the chain id a page declares', () => {
    declare('<meta name="gnoconnect:chainid" content="test5" />');
    expect(parseGnoConnectChainId()).toBe('test5');
  });

  it('reads it without an rpc tag', () => {
    // The whole point of this function: `rpc` is the field the wallet must not
    // act on, so it cannot be what gates the field the wallet needs.
    declare('<meta name="gnoconnect:chainid" content="dev" />');
    expect(parseGnoConnectChainId()).toBe('dev');
  });

  it('ignores an rpc tag when both are present', () => {
    declare(
      '<meta name="gnoconnect:rpc" content="tcp://127.0.0.1:26657" />' +
        '<meta name="gnoconnect:chainid" content="test5" />',
    );
    expect(parseGnoConnectChainId()).toBe('test5');
  });

  it('returns an empty string when the page declares nothing', () => {
    declare('<meta name="description" content="not ours" />');
    expect(parseGnoConnectChainId()).toBe('');
  });

  it('returns an empty string for an empty declaration', () => {
    declare('<meta name="gnoconnect:chainid" content="" />');
    expect(parseGnoConnectChainId()).toBe('');
  });
});
