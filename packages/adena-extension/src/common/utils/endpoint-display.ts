const MAX_DISPLAY_ENDPOINT_LENGTH = 64;

/**
 * A page-declared endpoint, reduced to an origin safe to show on an approval
 * screen; undefined when it is not a usable http(s) one. Bounded and parsed
 * because it is page-written: unclamped it pushes the transaction details off
 * screen, and `normalizeGnoConnectRpc` makes `javascript:alert(1)` look https.
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

  if (parsed.origin.length > MAX_DISPLAY_ENDPOINT_LENGTH) {
    return `${parsed.origin.slice(0, MAX_DISPLAY_ENDPOINT_LENGTH - 1)}…`;
  }

  return parsed.origin;
}
