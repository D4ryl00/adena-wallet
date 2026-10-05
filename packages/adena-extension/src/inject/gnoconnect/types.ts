// The GnoConnect standard's In-Page Wallets surface. Kept free of Adena's
// `WalletResponse` vocabulary; `response.ts` is where the two meet.

/** Announce handshake events, matching EIP-6963 / Wallet Standard. */
export const GNO_REGISTER_WALLET_EVENT = 'gno:registerWallet';
export const GNO_REQUEST_WALLET_EVENT = 'gno:requestWallet';

/** Durable across page loads and versions, unlike `uuid`. */
export const ADENA_RDNS = 'land.gno.adena';

/** How the wallet is presented in a page's chooser. */
export interface GnoWalletInfo {
  /** Unique per page load (UUIDv4), for deduplicating repeat announcements. */
  uuid: string;
  name: string;
  /** `data:image/` URI — no network fetch, works offline. */
  icon: string;
  /** Durable identity, reverse-DNS. What a page persists to remember a choice. */
  rdns: string;
}

/**
 * Named — the wallet resolves declaration order via `vm/qdoc` — or positional,
 * where the producer asserts the order and no lookup is needed. One form per
 * call; mixing is `invalid_request`.
 */
export type GnoTransactionArgument = { name: string; value: string } | { value: string };

export function isNamedArgument(
  arg: GnoTransactionArgument,
): arg is { name: string; value: string } {
  return typeof (arg as { name?: unknown }).name === 'string' && (arg as { name: string }).name !== '';
}

/** One message: what varies from one `MsgCall` to the next in a transaction. */
export interface GnoMessageIntent {
  path: string;
  func: string;
  /** Named or positional, but not both. A named call may prefill only some. */
  args: GnoTransactionArgument[];
  /** Coins to attach, gnokey syntax (e.g. `1000000ugnot`). */
  send?: string;
}

/** The intent a `sendtx` launch link carries, without its callback envelope. */
export interface GnoTransactionIntent extends GnoMessageIntent {
  /** Selects the network; falls back to `gnoconnect:chainid`. */
  chainid?: string;
  /** Advisory. Never used as an endpoint — only to prefill an add-network prompt. */
  rpc?: string;
  /** Pins the identity to act as; the wallet signs as it or declines. */
  signer?: string;
}

/**
 * Several messages, one signature, one broadcast. The chain and the signer sit
 * on the transaction, not on each message, so a request cannot name two of
 * either.
 */
export interface GnoBatchIntent {
  /** At least one; an empty batch is `invalid_request`. */
  msgs: GnoMessageIntent[];
  chainid?: string;
  rpc?: string;
  signer?: string;
}

/** The standard's error vocabulary, shared with launch-link callbacks. */
export type GnoErrorCode =
  | 'invalid_request'
  | 'network_declined'
  | 'signer_unavailable'
  | 'no_signer'
  /** In-page only: the origin has not been approved. */
  | 'not_connected'
  | 'unsupported_host'
  | 'tx_failed'
  /** Sessions: a proof that does not verify against its key. */
  | 'invalid_proof'
  /** Sessions: `iat` outside the wallet's window. */
  | 'stale_request'
  | 'session_expired'
  | 'session_not_found'
  /** Sessions: the identity has no free slot (16, expired ones included). */
  | 'session_limit';

/** A declining user is `Rejected`; only a genuine failure rejects the promise. */
export type UserResponse<T> =
  | { status: 'Approved'; args: T }
  | { status: 'Rejected'; code?: GnoErrorCode };

export interface GnoAccount {
  address: string;
  chainid: string;
  pubkey: string | null;
}

export interface GnoNetwork {
  chainid: string;
  rpc: string;
  name: string;
}

/**
 * What the page calls. `sendTx` is the core method; the rest are optional and
 * feature-detected. Names are the launch-link verbs cased for the medium.
 */
export interface GnoConnectProvider {
  sendTx(tx: GnoTransactionIntent): Promise<UserResponse<{ hash: string }>>;

  /**
   * Several messages in one transaction, the in-page analogue of `multi_msg`.
   * Named for what the caller supplies: it sends one transaction.
   */
  sendMsgs(tx: GnoBatchIntent): Promise<UserResponse<{ hash: string }>>;

  /** Sign without broadcasting. `signedtx` is base64 amino-binary, opaque. */
  signTx(tx: GnoTransactionIntent): Promise<UserResponse<{ signedtx: string }>>;

  connect(): Promise<UserResponse<GnoAccount>>;

  getAccount(): Promise<UserResponse<GnoAccount>>;

  getNetwork(): Promise<UserResponse<GnoNetwork>>;

  switchNetwork(chainid: string): Promise<UserResponse<{ chainid: string }>>;

  /** Subscribes to wallet-side changes; returns the unsubscribe function. */
  on<E extends keyof GnoProviderEvents>(
    event: E,
    listener: (detail: GnoProviderEvents[E]) => void,
  ): () => void;
}

/** What the wallet tells an approved origin when the user changes something. */
export interface GnoProviderEvents {
  accountChanged: GnoAccount;
  networkChanged: GnoNetwork;
  disconnect: null;
}

/**
 * Internal, payload-free nudge from the extension to the provider: "state may
 * have changed, re-read it". The page can forge it, which only costs a re-read.
 */
export const GNO_STATE_HINT_EVENT = 'adena:gnoconnect:state';
export const GNO_STATE_HINT_STATUS = 'gnoconnectHint';

export interface GnoWalletAnnouncement {
  info: GnoWalletInfo;
  provider: GnoConnectProvider;
}

/**
 * The no-script fallback's request to the background. The content script only
 * parses; the provider runs in the background, since a page with scripts
 * blocked cannot load it, not even as a module the content script imports.
 */
export const GNO_FALLBACK_SEND_TX = 'GNOCONNECT_FALLBACK_SEND_TX';

export interface FallbackSendTx {
  type: typeof GNO_FALLBACK_SEND_TX;
  intent: GnoTransactionIntent;
  siteName: string;
}

export type FallbackReply =
  | { response: UserResponse<{ hash: string }> }
  | { error: { code?: GnoErrorCode; message: string } };
