import { AdenaExecutor, ExecutorTransport } from '@inject/executor/executor';
import {
  normalizeGnoConnectRpc,
  parseGnoConnectChainId,
} from '@inject/message/methods/gno-connect';

import { createProviderEvents, Peek } from './events';
import { GnoConnectRequestError, toUserResponse } from './response';
import { buildTransactionParams, ResolvedNetwork } from './tx-builder';
import {
  GnoAccount,
  GnoBatchIntent,
  GnoConnectProvider,
  GnoNetwork,
  GnoTransactionIntent,
  UserResponse,
} from './types';

/** Both broadcast endpoints carry `hash` (tm2-js-client common.d.ts:154-167). */
interface BroadcastResultLike {
  hash?: string;
}

interface AccountResultLike {
  address?: string;
  chainId?: string;
  publicKey?: { value?: string } | null;
}

interface NetworkResultLike {
  chainId?: string;
  rpcUrl?: string;
  networkName?: string;
}

interface SignResultLike {
  encodedTransaction?: string;
}

/** Where the provider runs: the page, or the background acting for a page. */
export interface ProviderHost {
  executor(): AdenaExecutor;
  /** Cosmetic only: the approval shows the origin, which the page cannot forge. */
  siteName(): string;
  /** `gnoconnect:chainid` alone: the wallet never uses a declared `rpc`. */
  declaredChainId(): string;
}

const pageHost: ProviderHost = {
  executor: () => new AdenaExecutor(),
  siteName: () => document.title || window.location.hostname,
  declaredChainId: parseGnoConnectChainId,
};

/** A host whose requests travel over `transport` instead of `window` messaging. */
export function transportHost(
  transport: ExecutorTransport,
  siteName: string,
  declaredChainId: string,
): ProviderHost {
  return {
    executor: () => new AdenaExecutor(transport),
    siteName: () => siteName,
    declaredChainId: () => declaredChainId,
  };
}

/**
 * `chainid` selects the network; the request's `rpc` plays no part. A page that
 * could choose the node would choose the `vm/qdoc` document deciding argument
 * order, and the sequence and gas the user is shown.
 */
function requestedChainId(host: ProviderHost, batch: GnoBatchIntent): string {
  const requested = batch.chainid || host.declaredChainId();

  if (!requested) {
    throw new GnoConnectRequestError(
      'invalid_request',
      'No chainid: name the chain on the request or in gnoconnect:chainid metadata',
    );
  }

  return requested;
}

/**
 * Prompts the user. A decline is `network_declined`, and so is a chain the
 * wallet does not have: adding one must be its own approval, which `addNetwork`
 * remains available for.
 */
async function switchTo(host: ProviderHost, requested: string): Promise<ResolvedNetwork> {
  const switched = await host.executor().switchNetwork(requested);
  const result = toUserResponse(switched, () => null);
  if (result.status === 'Rejected') {
    throw new GnoConnectRequestError(
      'network_declined',
      `User declined switching to ${requested}`,
    );
  }
  return readNetwork(host);
}

async function readNetwork(host: ProviderHost): Promise<ResolvedNetwork> {
  const response = await host.executor().getNetwork();
  const resolved = toUserResponse(response, (data) => {
    const network = data as NetworkResultLike;
    return { chainId: network?.chainId ?? '', rpcUrl: network?.rpcUrl ?? '' };
  });

  if (resolved.status === 'Rejected') {
    throw new GnoConnectRequestError('network_declined', 'No active network');
  }
  return resolved.args;
}

/**
 * Half of enforcing the pin, and not the half that matters: this runs in the
 * page world, before the popup exists. The approval screen re-checks it against
 * the account it is about to sign with; this only saves a pointless approval.
 */
async function assertSigner(host: ProviderHost, pinned: string): Promise<void> {
  const response = await host.executor().getAccount();
  const account = toUserResponse(response, (data) => (data as AccountResultLike)?.address ?? '');
  if (account.status === 'Rejected' || account.args !== pinned) {
    throw new GnoConnectRequestError(
      'signer_unavailable',
      `Cannot sign as ${pinned}: it is not the active account`,
    );
  }
}

/**
 * Every executor call refuses with `NOT_CONNECTED` until the origin is
 * established, so without this the core method would depend on `connect`, which
 * the standard makes optional. Idempotent: `ALREADY_CONNECTED` reads as Approved.
 */
async function ensureEstablished(host: ProviderHost): Promise<void> {
  const established = await host.executor().addEstablish(host.siteName());
  const result = toUserResponse(established, () => null);
  if (result.status === 'Rejected') {
    throw new GnoConnectRequestError(
      'no_signer',
      'The user declined to connect this site to the wallet',
    );
  }
}

async function prepare(
  host: ProviderHost,
  batch: GnoBatchIntent,
): Promise<Awaited<ReturnType<typeof buildTransactionParams>>> {
  if (batch.msgs.length === 0) {
    throw new GnoConnectRequestError('invalid_request', 'No transaction intent supplied');
  }

  await ensureEstablished(host);

  const requested = requestedChainId(host, batch);
  const active = await readNetwork(host);
  const { signer } = batch;

  // Before the switch prompt, so a hopeless request costs the user nothing — but
  // only while we are on the chain the pin was read from, since an address is
  // prefixed per network and would not compare across a switch.
  if (signer && active.chainId === requested) {
    await assertSigner(host, signer);
  }

  const network = active.chainId === requested ? active : await switchTo(host, requested);

  // Display only: a chain id is not unique (`dev` names every devnet), so a
  // declared endpoint we are not using is the only signal `chainid` may have
  // picked a different network than the page meant.
  return buildTransactionParams(
    batch.msgs,
    network,
    batch.rpc ? normalizeGnoConnectRpc(batch.rpc) : undefined,
    signer,
  );
}

/** A single intent is a one-message batch. */
function toBatch(tx: GnoTransactionIntent): GnoBatchIntent {
  const { chainid, rpc, signer, ...msg } = tx;
  return { msgs: [msg], chainid, rpc, signer };
}

async function submit(
  host: ProviderHost,
  batch: GnoBatchIntent,
): Promise<UserResponse<{ hash: string }>> {
  const response = await host.executor().doContract(await prepare(host, batch));
  return toUserResponse(response, (data) => ({
    hash: (data as BroadcastResultLike)?.hash ?? '',
  }));
}

/** `sendTx` on behalf of a page, from wherever `host` runs. */
export function sendTxFrom(
  host: ProviderHost,
  tx: GnoTransactionIntent,
): Promise<UserResponse<{ hash: string }>> {
  return submit(host, toBatch(tx));
}

function toAccount(data: AccountResultLike): GnoAccount {
  return {
    address: data?.address ?? '',
    chainid: data?.chainId ?? '',
    pubkey: data?.publicKey?.value ?? null,
  };
}

function toNetwork(data: NetworkResultLike): GnoNetwork {
  return {
    chainid: data?.chainId ?? '',
    // The endpoint in effect, never one a page declared.
    rpc: data?.rpcUrl ?? '',
    name: data?.networkName ?? '',
  };
}

async function readAccount(host: ProviderHost): Promise<UserResponse<GnoAccount>> {
  const response = await host.executor().getAccount();
  return toUserResponse(response, (data) => toAccount(data as AccountResultLike));
}

async function readNetworkInfo(host: ProviderHost): Promise<UserResponse<GnoNetwork>> {
  const response = await host.executor().getNetwork();
  return toUserResponse(response, (data) => toNetwork(data as NetworkResultLike));
}

/** A gated read that never prompts; `not_connected` means the origin lost approval. */
async function peek<T>(read: () => Promise<UserResponse<T>>): Promise<Peek<T>> {
  try {
    const response = await read();
    return response.status === 'Approved' ? { value: response.args } : 'unknown';
  } catch (error) {
    return (error as { code?: string })?.code === 'not_connected' ? 'disconnected' : 'unknown';
  }
}

/** What the page was just told is not news, so it is not announced again. */
function remembered<T>(response: UserResponse<T>, remember: (value: T) => void): UserResponse<T> {
  if (response.status === 'Approved') {
    remember(response.args);
  }
  return response;
}

/**
 * Built entirely from executor calls Adena already implements, so every method
 * funnels through the existing approval screens. `signMessage` is absent:
 * everything signable in Gno today is a transaction.
 */
export function createGnoConnectProvider(host: ProviderHost = pageHost): GnoConnectProvider {
  const events = createProviderEvents(
    () => peek(() => readAccount(host)),
    () => peek(() => readNetworkInfo(host)),
  );

  const provider: GnoConnectProvider = {
    async sendTx(tx) {
      return sendTxFrom(host, tx);
    },

    async sendMsgs(tx) {
      return submit(host, tx);
    },

    async signTx(tx) {
      const response = await host.executor().signTx(await prepare(host, toBatch(tx)));
      // Base64 amino-binary, broadcast unmodified: re-encoding drops fields a
      // session or multisig signature carries.
      return toUserResponse(response, (data) => ({
        signedtx: (data as SignResultLike)?.encodedTransaction ?? '',
      }));
    },

    async connect() {
      const established = await host.executor().addEstablish(host.siteName());
      // A rejection short-circuits before the account is disclosed.
      const establishResult = toUserResponse(established, () => null);
      if (establishResult.status === 'Rejected') {
        return { status: 'Rejected', code: establishResult.code };
      }

      return remembered(await readAccount(host), events.rememberAccount);
    },

    async getAccount() {
      return remembered(await readAccount(host), events.rememberAccount);
    },

    async getNetwork() {
      return remembered(await readNetworkInfo(host), events.rememberNetwork);
    },

    async switchNetwork(chainid) {
      const response = await host.executor().switchNetwork(chainid);
      // Already on that network is the requested end state, so it reads as
      // approved. `UNADDED_NETWORK` is a genuine failure: adding is the user's call.
      return toUserResponse(response, () => ({ chainid }));
    },

    on: events.on,
  };

  return Object.freeze(provider);
}
