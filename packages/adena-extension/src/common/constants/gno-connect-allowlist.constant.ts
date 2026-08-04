// Loopback local hosts served by local gno nodes speak plain HTTP; every other
// host is assumed to be reachable over HTTPS. All that survives of the origin
// allowlist, which went with the page-declared endpoints it used to gate.
export const LOOPBACK_LOCAL_HOST_PATTERN = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;
