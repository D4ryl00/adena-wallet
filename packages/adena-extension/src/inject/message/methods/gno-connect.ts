import { LOOPBACK_LOCAL_HOST_PATTERN } from '@common/constants/gno-connect-allowlist.constant';
import {
  GNO_CHAIN_ID_META_TAG,
  GNO_CONNECT_PREFIX,
  GNO_RPC_META_TAG,
} from '@common/constants/metatag.constant';
import { hasHttpProtocol } from '@common/provider/gno/utils';

export interface GnoConnectInfo {
  rpc: string;
  chainId: string;
}

export interface GnoMessageInfo {
  packagePath: string;
  functionName: string;
  send: string;
  maxDeposit: string;
  args: GnoArgumentInfo[] | null;
}

export interface GnoArgumentInfo {
  index: number;
  key: string;
  value: string;
  type?: string;
}

/**
 * Parses GNO connect information from meta tags in the current document.
 * It looks for two specific meta tags:
 * - gno.connect.rpc (GNO_RPC_META_TAG)
 * - gno.connect.chainId (GNO_CHAIN_ID_META_TAG)
 *
 * @returns GnoConnectInfo object if both tags are found and have non-empty values;
 *          otherwise returns null.
 */
export function parseGnoConnectInfo(): GnoConnectInfo | null {
  if (document === null) {
    return null;
  }

  const gnoConnectInfo: GnoConnectInfo = {
    rpc: '',
    chainId: '',
  };

  const metas = document?.querySelectorAll('meta') || [];

  metas.forEach((meta) => {
    const name = meta.getAttribute('name');
    const content = meta.getAttribute('content') || '';

    if (!name || !name.startsWith(GNO_CONNECT_PREFIX)) {
      return;
    }

    switch (name) {
      case GNO_RPC_META_TAG:
        gnoConnectInfo.rpc = normalizeGnoConnectRpc(content);
        break;
      case GNO_CHAIN_ID_META_TAG:
        gnoConnectInfo.chainId = content;
        break;
    }
  });

  if (gnoConnectInfo.rpc === '' || gnoConnectInfo.chainId === '') {
    return null;
  }

  return gnoConnectInfo;
}

/**
 * Reads `gnoconnect:chainid` on its own.
 *
 * Deliberately separate from `parseGnoConnectInfo`, which requires *both* tags
 * because its consumer — the gnoweb event watcher — has nothing to do without an
 * endpoint. Network resolution wants the opposite: `chainid` selects the
 * network, and `rpc` is the one field the wallet is forbidden to act on, so
 * gating the chain id on an endpoint we will never use is backwards. A page that
 * declares only the chain — the correct thing for it to do — resolves fine.
 *
 * @returns the declared chain id, or '' when the page declares none.
 */
export function parseGnoConnectChainId(): string {
  if (document === null) {
    return '';
  }

  const metas = document?.querySelectorAll('meta') || [];

  let chainId = '';
  metas.forEach((meta) => {
    if (meta.getAttribute('name') === GNO_CHAIN_ID_META_TAG) {
      chainId = meta.getAttribute('content') || '';
    }
  });

  return chainId;
}

/**
 * Normalizes a gnoconnect RPC endpoint (declared via meta tag) into a fetchable
 * http(s) URL.
 *
 * gnoweb may declare the RPC with an http(s) scheme (kept as-is), a non-http
 * scheme such as `tcp://` (as local gno nodes commonly do), or no scheme at all.
 * Downstream RPC clients (tm2-rpc HttpClient, fetch, axios) reject anything
 * without an http(s) protocol, so any non-http input has its scheme replaced:
 * loopback hosts map to http://, all others to https://.
 */
export function normalizeGnoConnectRpc(url: string): string {
  const trimmedUrl = url.trim();

  if (trimmedUrl === '' || hasHttpProtocol(trimmedUrl)) {
    return trimmedUrl;
  }

  const withoutScheme = trimmedUrl.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//, '');
  const host = withoutScheme.split('/')[0];
  const protocol = LOOPBACK_LOCAL_HOST_PATTERN.test(host) ? 'http://' : 'https://';

  return `${protocol}${withoutScheme}`;
}
