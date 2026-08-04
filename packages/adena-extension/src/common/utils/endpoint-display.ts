const MAX_DISPLAY_ENDPOINT_LENGTH = 64;

/**
 * A page-declared endpoint, reduced to something safe to put on an approval
 * screen.
 *
 * The value reaches the wallet as meta-tag or request text a page wrote, and it
 * is shown next to the endpoint the wallet will actually use so the user can
 * spot a divergence. That makes it worth showing and worth distrusting: it never
 * reaches anything that queries or signs, but on screen an unbounded string
 * still pushes the transaction details out of view, and a value shaped like
 * `javascript:alert(1)` reads as an endpoint once the wallet has helpfully
 * prefixed a scheme onto it.
 *
 * So: parse it, and show the origin only. A string that is not a URL, or not one
 * over http(s), is not an endpoint and there is nothing honest to say about it —
 * drop it, and the review screen renders no divergence row at all.
 *
 * @returns `scheme://host[:port]`, or undefined when the value is not a usable
 *   http(s) endpoint.
 */
export function toDisplayEndpoint(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }

  // A hostname long enough to matter is not a real one, and the origin is all
  // the user needs to tell two endpoints apart. Bounded so the banner cannot
  // grow past its own line.
  if (parsed.origin.length > MAX_DISPLAY_ENDPOINT_LENGTH) {
    return `${parsed.origin.slice(0, MAX_DISPLAY_ENDPOINT_LENGTH - 1)}…`;
  }

  return parsed.origin;
}
