import { AdenaExecutor } from '@inject/executor/executor';
import {
  normalizeGnoConnectRpc,
  parseGnoConnectChainId,
} from '@inject/message/methods/gno-connect';

import { GnoConnectRequestError, toUserResponse } from './response';
import { buildTransactionParams, ResolvedNetwork } from './tx-builder';
import {
  GnoAccount,
  GnoConnectProvider,
  GnoNetwork,
  GnoTransactionIntent,
  UserResponse,
} from './types';

/**
 * A broadcast result carries `hash` on both endpoints — `BroadcastTxSyncResult`
 * and `BroadcastTxCommitResult` (tm2-js-client common.d.ts:154-167).
 */
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

/** The page's self-asserted label. Only cosmetic: the wallet shows the origin,
 * which the executor attaches to every message and the page cannot forge. */
function siteName(): string {
  return document.title || window.location.hostname;
}

/**
 * The chain the page declares, when an intent does not name one itself.
 *
 * Reads the chain id tag alone. A page that declares only `gnoconnect:chainid`
 * is doing the right thing — the wallet never uses a declared `rpc` — so it must
 * resolve, which is why this does not go through `parseGnoConnectInfo`.
 */
function pageDeclaredChainId(): string {
  return parseGnoConnectChainId();
}

/**
 * The chain the request selects, per the standard's Network resolution.
 *
 * `chainid` selects; the request's `rpc` plays no part. Adena signs and queries
 * through the endpoint the *user* configured for that chain, so a page cannot
 * choose the node that answers the `vm/qdoc` lookup deciding argument order, nor
 * the one that reports the sequence and gas the user is shown.
 */
function requestedChainId(intents: GnoTransactionIntent[]): string {
  const requested = intents.find((intent) => intent.chainid)?.chainid || pageDeclaredChainId();

  if (!requested) {
    throw new GnoConnectRequestError(
      'invalid_request',
      'No chainid: name the chain on the intent or in gnoconnect:chainid metadata',
    );
  }

  const mismatched = intents.find((intent) => intent.chainid && intent.chainid !== requested);
  if (mismatched) {
    throw new GnoConnectRequestError(
      'invalid_request',
      'All messages in one transaction must name the same chainid',
    );
  }

  return requested;
}

/**
 * Brings the wallet onto `requested`, prompting the user if it is not there.
 *
 * A chain the user has not configured is `network_declined` rather than a silent
 * add: the standard requires an add to be its own approval, separate from and
 * before any signing approval, and a wallet that does not offer one answers
 * exactly this. Adena's existing `addNetwork` remains available to a dapp as
 * that separate step.
 */
async function switchTo(requested: string): Promise<ResolvedNetwork> {
  // Prompts the user. A decline is Rejected (network_declined); a chain the
  // wallet does not have fails as UNADDED_NETWORK, likewise network_declined.
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
 * Fails a request whose `signer` pin is not the account the wallet would use.
 *
 * The early half of enforcing the pin: it costs nothing and it keeps a request
 * that cannot succeed from reaching an approval screen at all. It is *not* where
 * the guarantee lives — this runs in the page world, before the popup exists, so
 * the account it sees is not necessarily the one that ends up signing. The pin
 * travels on in `TransactionParams`, and the approval screen checks it again
 * against the account it is actually about to sign with. That second check is
 * the enforcing one; this one only saves a pointless approval.
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
 * Establishes the connection `sendTx` needs, if it is not already there.
 *
 * Every executor call refuses with `NOT_CONNECTED` until the origin has been
 * established, so without this the standard's *core* method would depend on
 * `connect` — which the standard makes *optional*. A page that implements only
 * `sendTx`, as gnoweb's chooser does, would get "a connection has not been
 * established" and no way to act on it.
 *
 * Unconditional rather than establish-on-failure: `ALREADY_CONNECTED` is one of
 * the benign types `toUserResponse` reports as Approved, so the call is
 * idempotent and costs one message when the site is already known. The user sees
 * the connect approval before the transaction approval on first use, and only
 * the transaction approval afterwards.
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
  intents: GnoTransactionIntent[],
): Promise<Awaited<ReturnType<typeof buildTransactionParams>>> {
  await ensureEstablished();

  const requested = requestedChainId(intents);
  const active = await readNetwork();
  const signer = intents.find((intent) => intent.signer)?.signer;

  // Checked before the switch prompt, but only while we are still on the chain
  // the page read the pin from. A request pinned to an account the wallet is not
  // on fails either way, so prompting for a network switch first asks the user
  // to answer for nothing. Across a switch the comparison stops being evidence —
  // an account's address is prefixed per network, so the same key reads
  // differently on the other side — hence no pre-check in that case. The
  // approval screen enforces the pin either way.
  if (signer && active.chainId === requested) {
    await assertSigner(signer);
  }

  const network = active.chainId === requested ? active : await switchTo(requested);

  // Display only. A chain id is not unique — `dev` names every devnet — so a
  // declared endpoint we are not using is the only signal that `chainid` may
  // have selected a different network than the page meant. Shown, never used.
  const declared = intents.find((intent) => intent.rpc)?.rpc;
  return buildTransactionParams(
    intents,
    network,
    declared ? normalizeGnoConnectRpc(declared) : undefined,
    signer,
  );
}

async function submit(
  intents: GnoTransactionIntent[],
): Promise<UserResponse<{ hash: string }>> {
  const response = await new AdenaExecutor().doContract(await prepare(intents));
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
 * The GnoConnect in-page surface, built entirely from executor calls Adena
 * already implements. Every method funnels through the same approval screens as
 * `window.adena`, so nothing here can sign without user review.
 *
 * Deliberately absent: `signMessage`. Everything signable in Gno today is a
 * transaction — Adena's `Sign`/`signAmino` signs a transaction document — so
 * announcing it under that name would mislead a page that feature-detects it.
 */
export function createGnoConnectProvider(): GnoConnectProvider {
  const provider: GnoConnectProvider = {
    async sendTx(tx) {
      return submit([tx]);
    },

    async sendTxs(txs) {
      return submit(txs);
    },

    async signTx(tx) {
      const response = await new AdenaExecutor().signTx(await prepare([tx]));
      // Base64 amino-binary, the exact string broadcast_tx_sync takes. The page
      // broadcasts it unmodified: decoding and re-encoding needs a client that
      // can represent whatever scheme the wallet signed with, and a session or
      // multisig signature carries fields a generic client drops.
      return toUserResponse(response, (data) => ({
        signedtx: (data as SignResultLike)?.encodedTransaction ?? '',
      }));
    },

    async connect() {
      const established = await new AdenaExecutor().addEstablish(siteName());
      // `ALREADY_CONNECTED` is a failure in Adena's vocabulary but an approval
      // here; `toUserResponse` treats it as benign. A rejection short-circuits
      // before the account is disclosed.
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
          // The endpoint actually in effect, never one a page declared.
          rpc: network?.rpcUrl ?? '',
          name: network?.networkName ?? '',
        };
      });
    },

    async switchNetwork(chainid) {
      const response = await new AdenaExecutor().switchNetwork(chainid);
      // `REDUNDANT_CHANGE_REQUEST` — already on that network — is the requested
      // end state, so `toUserResponse` reports it as approved. `UNADDED_NETWORK`
      // is a genuine failure: the page asked for a network the user has not
      // configured, and adding one is the user's call, in its own approval.
      return toUserResponse(response, () => ({ chainid }));
    },
  };

  return Object.freeze(provider);
}
