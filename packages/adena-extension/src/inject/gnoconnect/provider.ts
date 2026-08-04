import { AdenaExecutor } from '@inject/executor/executor';
import {
  normalizeGnoConnectRpc,
  parseGnoConnectChainId,
} from '@inject/message/methods/gno-connect';

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

// Cosmetic only: the approval shows the origin, which the executor attaches and
// the page cannot forge.
function siteName(): string {
  return document.title || window.location.hostname;
}

/**
 * Reads the chain id tag alone, not `parseGnoConnectInfo`: a page declaring only
 * `gnoconnect:chainid` is correct, since the wallet never uses a declared `rpc`.
 */
function pageDeclaredChainId(): string {
  return parseGnoConnectChainId();
}

/**
 * `chainid` selects the network; the request's `rpc` plays no part. A page that
 * could choose the node would choose the `vm/qdoc` document deciding argument
 * order, and the sequence and gas the user is shown.
 */
function requestedChainId(batch: GnoBatchIntent): string {
  const requested = batch.chainid || pageDeclaredChainId();

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
async function switchTo(requested: string): Promise<ResolvedNetwork> {
  const switched = await new AdenaExecutor().switchNetwork(requested);
  const result = toUserResponse(switched, () => null);
  if (result.status === 'Rejected') {
    throw new GnoConnectRequestError(
      'network_declined',
      `User declined switching to ${requested}`,
    );
  }
  return readNetwork();
}

async function readNetwork(): Promise<ResolvedNetwork> {
  const response = await new AdenaExecutor().getNetwork();
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
async function assertSigner(pinned: string): Promise<void> {
  const response = await new AdenaExecutor().getAccount();
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
async function ensureEstablished(): Promise<void> {
  const established = await new AdenaExecutor().addEstablish(siteName());
  const result = toUserResponse(established, () => null);
  if (result.status === 'Rejected') {
    throw new GnoConnectRequestError(
      'no_signer',
      'The user declined to connect this site to the wallet',
    );
  }
}

async function prepare(
  batch: GnoBatchIntent,
): Promise<Awaited<ReturnType<typeof buildTransactionParams>>> {
  if (batch.msgs.length === 0) {
    throw new GnoConnectRequestError('invalid_request', 'No transaction intent supplied');
  }

  await ensureEstablished();

  const requested = requestedChainId(batch);
  const active = await readNetwork();
  const { signer } = batch;

  // Before the switch prompt, so a hopeless request costs the user nothing — but
  // only while we are on the chain the pin was read from, since an address is
  // prefixed per network and would not compare across a switch.
  if (signer && active.chainId === requested) {
    await assertSigner(signer);
  }

  const network = active.chainId === requested ? active : await switchTo(requested);

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

async function submit(batch: GnoBatchIntent): Promise<UserResponse<{ hash: string }>> {
  const response = await new AdenaExecutor().doContract(await prepare(batch));
  return toUserResponse(response, (data) => ({
    hash: (data as BroadcastResultLike)?.hash ?? '',
  }));
}

function toAccount(data: AccountResultLike): GnoAccount {
  return {
    address: data?.address ?? '',
    chainid: data?.chainId ?? '',
    pubkey: data?.publicKey?.value ?? null,
  };
}

/**
 * Built entirely from executor calls Adena already implements, so every method
 * funnels through the existing approval screens. `signMessage` is absent:
 * everything signable in Gno today is a transaction.
 */
export function createGnoConnectProvider(): GnoConnectProvider {
  const provider: GnoConnectProvider = {
    async sendTx(tx) {
      return submit(toBatch(tx));
    },

    async sendMsgs(tx) {
      return submit(tx);
    },

    async signTx(tx) {
      const response = await new AdenaExecutor().signTx(await prepare(toBatch(tx)));
      // Base64 amino-binary, broadcast unmodified: re-encoding drops fields a
      // session or multisig signature carries.
      return toUserResponse(response, (data) => ({
        signedtx: (data as SignResultLike)?.encodedTransaction ?? '',
      }));
    },

    async connect() {
      const established = await new AdenaExecutor().addEstablish(siteName());
      // A rejection short-circuits before the account is disclosed.
      const establishResult = toUserResponse(established, () => null);
      if (establishResult.status === 'Rejected') {
        return { status: 'Rejected', code: establishResult.code };
      }

      const account = await new AdenaExecutor().getAccount();
      return toUserResponse(account, (data) => toAccount(data as AccountResultLike));
    },

    async getAccount() {
      const response = await new AdenaExecutor().getAccount();
      return toUserResponse(response, (data) => toAccount(data as AccountResultLike));
    },

    async getNetwork() {
      const response = await new AdenaExecutor().getNetwork();
      return toUserResponse(response, (data): GnoNetwork => {
        const network = data as NetworkResultLike;
        return {
          chainid: network?.chainId ?? '',
          // The endpoint in effect, never one a page declared.
          rpc: network?.rpcUrl ?? '',
          name: network?.networkName ?? '',
        };
      });
    },

    async switchNetwork(chainid) {
      const response = await new AdenaExecutor().switchNetwork(chainid);
      // Already on that network is the requested end state, so it reads as
      // approved. `UNADDED_NETWORK` is a genuine failure: adding is the user's call.
      return toUserResponse(response, () => ({ chainid }));
    },
  };

  return Object.freeze(provider);
}
