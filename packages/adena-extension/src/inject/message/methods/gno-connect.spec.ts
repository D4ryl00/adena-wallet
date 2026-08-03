import {
  canHandleGnoConnectOrigin,
  getLoopbackGnoConnectChainId,
  isAllowedGnoConnectOrigin,
  getLoopbackGnoConnectRejection,
  isLoopbackGnoConnectTrusted,
  normalizeGnoConnectRpc,
} from './gno-connect';

describe('isAllowedGnoConnectOrigin', () => {
  it('returns true for registered gno.land origins', () => {
    expect(isAllowedGnoConnectOrigin('https://gno.land')).toBe(true);
    expect(isAllowedGnoConnectOrigin('https://onyx.testnets.gno.land')).toBe(true);
  });

  it('returns false for unregistered origins', () => {
    expect(isAllowedGnoConnectOrigin('https://attacker.example')).toBe(false);
    expect(isAllowedGnoConnectOrigin('https://evil.gno.land.attacker.example')).toBe(false);
  });

  it('rejects scheme mismatches', () => {
    expect(isAllowedGnoConnectOrigin('http://gno.land')).toBe(false);
  });

  it('rejects origins with explicit non-default port', () => {
    expect(isAllowedGnoConnectOrigin('https://gno.land:8443')).toBe(false);
  });

  it('rejects empty origin', () => {
    expect(isAllowedGnoConnectOrigin('')).toBe(false);
  });

  it('rejects subdomain takeover patterns', () => {
    expect(isAllowedGnoConnectOrigin('https://malicious.gno.land')).toBe(false);
  });

  it('never statically trusts loopback origins', () => {
    expect(isAllowedGnoConnectOrigin('http://127.0.0.1:8888')).toBe(false);
    expect(isAllowedGnoConnectOrigin('http://localhost:8888')).toBe(false);
  });
});

describe('canHandleGnoConnectOrigin', () => {
  it('handles the origins chains.json declares over https', () => {
    expect(canHandleGnoConnectOrigin('https://gno.land')).toBe(true);
    expect(canHandleGnoConnectOrigin('https://onyx.testnets.gno.land')).toBe(true);
  });

  it('handles loopback origins, whose trust is decided later at runtime', () => {
    expect(canHandleGnoConnectOrigin('http://127.0.0.1:8888')).toBe(true);
  });

  it('never handles an origin no bundled chain declares', () => {
    // Retiring a chain from chains.json (as upstream did for pearl-1) drops its
    // gnoUrl from the allowlist. Anchors and forms on such an origin must fall
    // through to the page instead of being swallowed by an interceptor that has
    // nothing to do with the click.
    expect(canHandleGnoConnectOrigin('https://example.com')).toBe(false);
    expect(canHandleGnoConnectOrigin('https://pearl.testnets.gno.land')).toBe(false);
    expect(canHandleGnoConnectOrigin('http://127.0.0.1:9999')).toBe(false);
    expect(canHandleGnoConnectOrigin('')).toBe(false);
  });

  it('agrees with isAllowedGnoConnectOrigin for every remote origin it handles', () => {
    const remoteHandled = [
      'https://gno.land',
      'https://onyx.testnets.gno.land',
      'https://example.com',
    ];
    remoteHandled.forEach((origin) => {
      expect(canHandleGnoConnectOrigin(origin)).toBe(isAllowedGnoConnectOrigin(origin));
    });
  });
});

describe('getLoopbackGnoConnectChainId', () => {
  it('returns the chainId a known loopback origin may act as', () => {
    expect(getLoopbackGnoConnectChainId('http://127.0.0.1:8888')).toBe('dev');
  });

  it('returns null for non-loopback or unknown origins', () => {
    expect(getLoopbackGnoConnectChainId('https://gno.land')).toBeNull();
    expect(getLoopbackGnoConnectChainId('http://127.0.0.1:9999')).toBeNull();
  });
});

describe('isLoopbackGnoConnectTrusted', () => {
  const LOOPBACK_CHAIN_ID = 'dev';

  it('trusts a loopback origin when both the meta chainId and the active network match', () => {
    expect(isLoopbackGnoConnectTrusted(LOOPBACK_CHAIN_ID, 'dev', 'dev')).toBe(true);
  });

  it('rejects a foreign meta chainId even when the active network matches the origin', () => {
    // Regression: a page served from http://127.0.0.1:8888 (origin -> dev) while
    // the wallet is already on dev must not be allowed to declare a different
    // chainId (e.g. gnoland-1) and switch/sign against a foreign network.
    expect(isLoopbackGnoConnectTrusted(LOOPBACK_CHAIN_ID, 'gnoland-1', 'dev')).toBe(false);
  });

  it('rejects when the active network is not the loopback chainId', () => {
    expect(isLoopbackGnoConnectTrusted(LOOPBACK_CHAIN_ID, 'dev', 'gnoland-1')).toBe(false);
  });

  it('rejects when the active network is unavailable (e.g. wallet locked)', () => {
    expect(isLoopbackGnoConnectTrusted(LOOPBACK_CHAIN_ID, 'dev', undefined)).toBe(false);
  });

  it('rejects when neither the meta chainId nor the active network match', () => {
    expect(isLoopbackGnoConnectTrusted(LOOPBACK_CHAIN_ID, 'gnoland-1', 'gnoland-1')).toBe(false);
  });
});

describe('getLoopbackGnoConnectRejection', () => {
  const LOOPBACK_CHAIN_ID = 'dev';

  it('reports no rejection exactly when the origin is trusted', () => {
    expect(getLoopbackGnoConnectRejection(LOOPBACK_CHAIN_ID, 'dev', 'dev')).toBeNull();
  });

  it('names a foreign meta chainId as the origin mismatch', () => {
    expect(getLoopbackGnoConnectRejection(LOOPBACK_CHAIN_ID, 'gnoland-1', 'dev')).toBe(
      'ORIGIN_CHAIN_MISMATCH',
    );
  });

  it('names an absent active network as the wallet being unavailable', () => {
    // What a locked wallet looks like from the gate: getNetwork answers
    // WALLET_LOCKED, so the caller has no chainId to hand over.
    expect(getLoopbackGnoConnectRejection(LOOPBACK_CHAIN_ID, 'dev', undefined)).toBe(
      'WALLET_UNAVAILABLE',
    );
  });

  it('names a different active network as the network mismatch', () => {
    expect(getLoopbackGnoConnectRejection(LOOPBACK_CHAIN_ID, 'dev', 'gnoland-1')).toBe(
      'ACTIVE_NETWORK_MISMATCH',
    );
  });

  it('prefers the origin mismatch, which holds regardless of wallet state', () => {
    expect(getLoopbackGnoConnectRejection(LOOPBACK_CHAIN_ID, 'gnoland-1', undefined)).toBe(
      'ORIGIN_CHAIN_MISMATCH',
    );
  });

  it('agrees with the trust decision over every combination', () => {
    // The reason exists to be reported, never to be acted on. Pinning the two
    // together means a future edit cannot let the message and the decision drift
    // — the case that would tell a user their wallet is fine while it refuses.
    const chainIds: (string | undefined)[] = [undefined, 'dev', 'gnoland-1', ''];

    for (const metaChainId of chainIds) {
      for (const activeChainId of chainIds) {
        if (metaChainId === undefined) {
          continue;
        }

        const trusted = isLoopbackGnoConnectTrusted(LOOPBACK_CHAIN_ID, metaChainId, activeChainId);
        const rejection = getLoopbackGnoConnectRejection(
          LOOPBACK_CHAIN_ID,
          metaChainId,
          activeChainId,
        );

        expect(rejection === null).toBe(trusted);
      }
    }
  });
});

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
