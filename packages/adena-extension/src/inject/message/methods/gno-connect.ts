import { LOOPBACK_LOCAL_HOST_PATTERN } from '@common/constants/gno-connect-allowlist.constant';
import {
  GNO_CHAIN_ID_META_TAG,
  GNO_CONNECT_PREFIX,
  GNO_RPC_META_TAG,
  GNO_TXDOMAINS_META_TAG,
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
 * Separate from `parseGnoConnectInfo`, which requires both tags for the gnoweb
 * event watcher: gating the chain id on an endpoint the wallet is forbidden to
 * act on is backwards. Returns '' when the page declares none.
 */
export function parseGnoConnectChainId(): string {
  return readGnoConnectMeta(GNO_CHAIN_ID_META_TAG) ?? '';
}

/** `gnoconnect:txdomains` as trimmed entries, or null when the page declares none. */
export function parseGnoConnectTxDomains(): string[] | null {
  const declared = readGnoConnectMeta(GNO_TXDOMAINS_META_TAG);
  return declared === null ? null : declared.split(',').map((domain) => domain.trim());
}

/** A meta tag's content, the last one winning; null when absent. */
function readGnoConnectMeta(name: string): string | null {
  if (document === null) {
    return null;
  }

  let content: string | null = null;
  document?.querySelectorAll('meta').forEach((meta) => {
    if (meta.getAttribute('name') === name) {
      content = meta.getAttribute('content') || '';
    }
  });

  return content;
}

/**
 * Into a fetchable http(s) URL. gnoweb may declare `tcp://`, as local gno nodes
 * do, or no scheme at all; downstream clients reject anything but http(s), so
 * loopback hosts map to http:// and everything else to https://.
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
