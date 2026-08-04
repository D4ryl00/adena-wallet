/**
 * GnoConnect in-page wallet types.
 *
 * These mirror the "In-Page Wallets" section of the GnoConnect standard. They
 * are deliberately kept free of Adena's own `WalletResponse` vocabulary: the
 * announced provider is the standard's surface, and `response.ts` is the only
 * place the two vocabularies meet.
 */

/** Event names of the announce handshake, matching EIP-6963 / Wallet Standard. */
export const GNO_REGISTER_WALLET_EVENT = 'gno:registerWallet';
export const GNO_REQUEST_WALLET_EVENT = 'gno:requestWallet';

/** Reverse-DNS identity. Durable across page loads and versions, unlike `uuid`. */
export const ADENA_RDNS = 'land.gno.adena';

/** How the wallet is presented in a page's chooser. */
export interface GnoWalletInfo {
  /** Announcement handle, unique per page load (UUIDv4). Deduplicates repeats. */
  uuid: string;
  /** Human-readable, shown to the user. */
  name: string;
  /** `data:image/` URI — no network fetch, works offline. */
  icon: string;
  /** Durable identity, reverse-DNS. What a page persists when remembering a choice. */
  rdns: string;
}

/**
 * One function argument, in either of the standard's two forms.
 *
 * A `MsgCall` takes arguments positionally and every one of them is a string, so
 * order carries the whole meaning and nothing downstream catches a wrong one.
 * The producer picks how to express that:
 *
 * - **Named** — the wallet resolves declaration order via `vm/qdoc`, so the
 *   producer need not know it, but the lookup needs the network.
 * - **Positional** — the producer asserts the order and takes responsibility;
 *   no lookup, so this is the form that works without network access.
 *
 * One form per call: mixing is `invalid_request`, because a named argument among
 * positional ones has a position knowable only through the lookup the positional
 * form exists to avoid.
 */
export type GnoTransactionArgument = { name: string; value: string } | { value: string };

export function isNamedArgument(
  arg: GnoTransactionArgument,
): arg is { name: string; value: string } {
  return typeof (arg as { name?: unknown }).name === 'string' && (arg as { name: string }).name !== '';
}

/**
 * The transaction intent carried by `sendTx`.
 *
 * Same intent as a `sendtx` launch link (path/func/args/send/network/signer),
 * without the launch link's envelope — a direct call returns a Promise, so it
 * needs no `callback`/`state` for out-of-band delivery.
 */
/**
 * One message. Everything here varies from one `MsgCall` to the next within a
 * single transaction.
 */
export interface GnoMessageIntent {
  /** Full package path, e.g. `gno.land/r/demo/boards`. */
  path: string;
  /** Exported function name. */
  func: string;
  /** Named or positional, but not both. A named call may prefill only some. */
  args: GnoTransactionArgument[];
  /** Coins to attach, gnokey syntax (e.g. `1000000ugnot`). */
  send?: string;
}

export interface GnoTransactionIntent extends GnoMessageIntent {
  /**
   * Selects the network. Falls back to `gnoconnect:chainid`; with neither, the
   * request is `invalid_request` — a signature is chain-bound, so "whichever
   * chain the wallet happens to be on" is how a dapp built for one chain gets a
   * signature valid on another.
   */
  chainid?: string;
  /**
   * Advisory only. Adena queries and broadcasts through its own configured
   * endpoint for `chainid`; this is never used as an endpoint, only to prefill
   * an add-network proposal for a chain the wallet does not have.
   */
  rpc?: string;
  /**
   * Pins the identity to act as — the `address` from a prior `connect`. When
   * present the wallet MUST sign as it or decline with `signer_unavailable`.
   * Without it, a page that connected as one account and rendered its address
   * signs as whatever account the user has since switched to.
   */
  signer?: string;
}

/**
 * Several messages, one signature, one broadcast.
 *
 * The transaction-level fields sit here rather than on each message because only
 * the message fields can vary within one broadcast: one transaction lands on one
 * chain under one signature. An array of full intents let a page name two chains
 * or two signers in one request — something with no meaning, which every wallet
 * would then answer differently and indistinguishably. Hoisting makes it
 * unwritable instead.
 */
export interface GnoBatchIntent {
  /** At least one; an empty batch is `invalid_request`. */
  msgs: GnoMessageIntent[];
  /** Selects the network, exactly as on a single intent. */
  chainid?: string;
  /** Advisory only, exactly as on a single intent. */
  rpc?: string;
  /** Pins the identity to act as, for the whole transaction. */
  signer?: string;
}

/**
 * The standard's error vocabulary, shared with launch-link callbacks so a page
 * handles failures identically whichever transport it used.
 */
export type GnoErrorCode =
  | 'invalid_request'
  | 'network_declined'
  | 'signer_unavailable'
  | 'no_signer'
  /** In-page only: the origin has not been approved and this method is gated on it. */
  | 'not_connected'
  | 'unsupported_host'
  | 'tx_failed';

/**
 * A declining user is `Rejected`, not a thrown error: refusing to sign is an
 * answer. Only a genuine failure — network, malformed request, locked wallet —
 * rejects the promise, and it rejects with a `GnoErrorCode`.
 */
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
 * What the page calls.
 *
 * `sendTx` is the core method; everything else is optional and MUST be
 * feature-detected by the page. Adena announces the optional methods it already
 * implements — see `provider.ts`.
 *
 * Method names are the launch-link verbs cased for the medium: a URL host is
 * case-insensitive per RFC 3986 so it cannot be camelCase, a JavaScript method
 * conventionally is. `sendtx` and `sendTx` are the same verb.
 */
export interface GnoConnectProvider {
  sendTx(tx: GnoTransactionIntent): Promise<UserResponse<{ hash: string }>>;

  /**
   * Multi-message extension. Adena builds multi-message transactions natively,
   * so the standard's single-message baseline is a subset of what it can do.
   * Announced as the in-page analogue of the `multi_msg` feature token.
   */
  sendTxs(tx: GnoBatchIntent): Promise<UserResponse<{ hash: string }>>;

  /** Sign without broadcasting. `signedtx` is base64 amino-binary, opaque. */
  signTx(tx: GnoTransactionIntent): Promise<UserResponse<{ signedtx: string }>>;

  connect(): Promise<UserResponse<GnoAccount>>;

  getAccount(): Promise<UserResponse<GnoAccount>>;

  getNetwork(): Promise<UserResponse<GnoNetwork>>;

  switchNetwork(chainid: string): Promise<UserResponse<{ chainid: string }>>;
}

export interface GnoWalletAnnouncement {
  info: GnoWalletInfo;
  provider: GnoConnectProvider;
}
