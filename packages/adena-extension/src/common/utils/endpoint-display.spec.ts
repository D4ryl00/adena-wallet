import { toDisplayEndpoint } from './endpoint-display';

describe('toDisplayEndpoint', () => {
  it('reduces an endpoint to its origin', () => {
    expect(toDisplayEndpoint('https://rpc.gno.land:443/path?q=1#frag')).toBe(
      'https://rpc.gno.land',
    );
    expect(toDisplayEndpoint('http://127.0.0.1:26657/')).toBe('http://127.0.0.1:26657');
  });

  it('drops a value that is not a URL', () => {
    expect(toDisplayEndpoint('not an endpoint')).toBeUndefined();
    expect(toDisplayEndpoint('rpc.gno.land')).toBeUndefined();
  });

  it('drops a non-http(s) scheme', () => {
    // The page writes this string. A scheme the wallet would never fetch has no
    // business being presented as the endpoint the site expected.
    expect(toDisplayEndpoint('javascript:alert(1)')).toBeUndefined();
    expect(toDisplayEndpoint('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(toDisplayEndpoint('tcp://127.0.0.1:26657')).toBeUndefined();
  });

  it('drops what normalizeGnoConnectRpc makes of a javascript: URL', () => {
    // normalizeGnoConnectRpc prefixes a scheme onto anything it does not
    // recognize, which turns `javascript:alert(1)` into something that looks
    // like an https endpoint. It does not survive parsing.
    expect(toDisplayEndpoint('https://javascript:alert(1)')).toBeUndefined();
  });

  it('drops an empty or absent value', () => {
    expect(toDisplayEndpoint('')).toBeUndefined();
    expect(toDisplayEndpoint(undefined)).toBeUndefined();
  });

  it('clamps an origin long enough to distort the banner', () => {
    const long = `https://${'a'.repeat(300)}.example`;
    const displayed = toDisplayEndpoint(long);

    expect(displayed).toBeDefined();
    expect((displayed as string).length).toBeLessThanOrEqual(64);
    expect(displayed).toMatch(/…$/);
  });
});
