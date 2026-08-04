// Loopback local hosts served by local gno nodes speak plain HTTP; every other host
// is assumed to be reachable over HTTPS.
//
// This pattern is all that survives of the gnoconnect origin allowlist. The
// allowlist decided which pages were permitted to declare an RPC endpoint the
// wallet would then *use* — but nothing is driven from page metadata any more:
// `chainid` selects among the networks the user configured, and a declared `rpc`
// is display-only. With no page-declared endpoint to honor there is no trust
// decision left to make about an origin, so the allowlist and its loopback
// runtime gate are gone. `normalizeGnoConnectRpc` still needs to pick a scheme,
// which is why the pattern stays.
export const LOOPBACK_LOCAL_HOST_PATTERN = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;
