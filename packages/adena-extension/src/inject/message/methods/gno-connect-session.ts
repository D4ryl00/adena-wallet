// The background side of the in-page GnoConnect sessions: `connect(opts)` with
// a key and `disconnect(req?)`. Everything the page sends is checked here,
// before any window: shape, proof, freshness, replay. The wallet's storage,
// chain and review window come in as `SessionDeps`, so this file is testable
// without Chrome.
import { GnoConnectRequestError } from '@inject/gnoconnect/errors';
import {
  checkFreshness,
  decodeGpub,
  SessionHost,
  SessionRequestFields,
  validateSessionRequest,
  verifyProof,
} from '@inject/gnoconnect/session-request';
import {
  GNOCONNECT_SESSION_CHECK,
  GNOCONNECT_SESSION_CONNECT,
  GNOCONNECT_SESSION_DISCONNECT,
  GnoErrorCode,
  GnoSessionAnswer,
  UserResponse,
} from '@inject/gnoconnect/types';

// CHECK: before any window — shape, proof, freshness, replay; answers nothing else.
// CONNECT: a checked `connect` with a key — identity, chain lookup, review.
// DISCONNECT: withdraws the origin's approval; with a key, the review first.

export const GNOCONNECT_SESSION_TYPES: ReadonlySet<string> = new Set([
  GNOCONNECT_SESSION_CHECK,
  GNOCONNECT_SESSION_CONNECT,
  GNOCONNECT_SESSION_DISCONNECT,
]);

/** The chain's cap, expired sessions included. */
const MAX_SESSIONS = 16;
const REPLAY_WINDOW = 600;

export interface SessionMessageData {
  host: SessionHost;
  /** `null` for a `disconnect()` without a key. */
  fields: unknown;
}

export interface OnChainSession {
  expiresAt: number;
  allow: string[];
  spend: string;
  period: number;
}

/** What the review window gets: the request as checked, and what the wallet resolved. */
export interface SessionReviewRequest {
  host: SessionHost;
  fields: SessionRequestFields;
  /** Authenticated by the browser; it replaces the launch link's callback host. */
  origin: string;
  identity: string;
  chainId: string;
  rpcUrl: string;
  /** With `old`: whether it is still a session, so revoked in the same transaction. */
  onChainOld: boolean;
}

export interface SessionIdentity {
  address: string;
  pubkey: string | null;
  isSession: boolean;
}

export interface SessionDeps {
  origin: string;
  isEstablished(): Promise<boolean>;
  withdrawApproval(): Promise<void>;
  network(): Promise<{ chainId: string; rpcUrl: string } | null>;
  /** `'locked'` when the wallet cannot tell; `null` with no account at all. */
  identity(): Promise<SessionIdentity | 'locked' | null>;
  getSession(master: string, session: string): Promise<OnChainSession | null>;
  countSessions(master: string): Promise<number>;
  /** The latest block time, never later than the clock; null without a usable one. */
  chainNow(): Promise<number | null>;
  clock(): number;
  /** Opens the review window and resolves with its answer. */
  review(request: SessionReviewRequest): Promise<GnoSessionAnswer>;
}

/** A session answer: the page's response, or a genuine failure the provider throws. */
export type SessionAnswer = GnoSessionAnswer;

export const FEATURES = ['sendtx', 'signtx', 'multi_msg', 'sessions'];

/**
 * The `(pubkey, state)` pairs accepted in the last 10 minutes. CHECK marks a
 * pair; the CONNECT or DISCONNECT that follows consumes it, so each checked
 * request is acted on once.
 */
export interface ReplayMemory {
  check(pubkey: string, state: string, now: number): boolean;
  consume(pubkey: string, state: string, now: number): boolean;
}

export function createReplayMemory(): ReplayMemory {
  const seen = new Map<string, { at: number; consumed: boolean }>();
  const prune = (now: number): void => {
    seen.forEach((v, k) => {
      if (now - v.at > REPLAY_WINDOW) seen.delete(k);
    });
  };
  const id = (pubkey: string, state: string): string => JSON.stringify([pubkey, state]);
  return {
    check(pubkey, state, now): boolean {
      prune(now);
      if (seen.has(id(pubkey, state))) return false;
      seen.set(id(pubkey, state), { at: now, consumed: false });
      return true;
    },
    consume(pubkey, state, now): boolean {
      prune(now);
      const entry = seen.get(id(pubkey, state));
      if (!entry || entry.consumed) return false;
      entry.consumed = true;
      return true;
    },
  };
}

const rejected = (code?: GnoErrorCode): UserResponse<never> =>
  code ? { status: 'Rejected', code } : { status: 'Rejected' };

/** Shape, proof and freshness: the request may be shown to the user. */
async function checked(
  deps: SessionDeps,
  host: SessionHost,
  input: unknown,
): Promise<SessionRequestFields> {
  const fields = validateSessionRequest(host, input);
  await verifyProof(host, fields);
  checkFreshness(fields.iat, deps.clock());
  return fields;
}

type Resolved = { identity: SessionIdentity; network: { chainId: string; rpcUrl: string } };

/** Network, then identity. A `SessionAnswer` when the request stops here. */
async function resolve(
  deps: SessionDeps,
  fields: SessionRequestFields,
): Promise<Resolved | SessionAnswer> {
  const network = await deps.network();
  if (!network || network.chainId !== fields.chainid) return rejected('network_declined');
  const identity = await deps.identity();
  if (identity === 'locked') return { fail: 'no_signer', message: 'The wallet is locked' };
  if (!identity) return { fail: 'no_signer', message: 'The wallet has no account' };
  // A session cannot sign `auth` messages, so it cannot grant or revoke one.
  if (identity.isSession) return rejected('signer_unavailable');
  if (fields.signer && fields.signer !== identity.address) return rejected('signer_unavailable');
  return { identity, network };
}

async function connectWithKey(deps: SessionDeps, fields: SessionRequestFields): Promise<SessionAnswer> {
  if (!(await deps.isEstablished())) {
    return { fail: 'not_connected', message: 'This site is not connected to the wallet' };
  }
  const resolved = await resolve(deps, fields);
  if (!('identity' in resolved)) return resolved;
  const { identity, network } = resolved;

  const key = decodeGpub(fields.pubkey);
  const now = (await deps.chainNow()) ?? deps.clock();
  const account = { address: identity.address, chainid: network.chainId, pubkey: identity.pubkey, features: FEATURES };

  const existing = await deps.getSession(identity.address, key.address);
  if (existing) {
    // `connect` is safe to repeat: a page whose answer was lost asks again.
    if (existing.expiresAt !== 0 && existing.expiresAt <= now) return rejected('session_expired');
    return { status: 'Approved', args: { ...account, session: key.address, ...existing } };
  }

  const onChainOld = fields.old
    ? (await deps.getSession(identity.address, decodeGpub(fields.old).address)) !== null
    : false;
  // Revoking `old` in the same transaction frees its slot.
  if ((await deps.countSessions(identity.address)) - (onChainOld ? 1 : 0) >= MAX_SESSIONS) {
    return rejected('session_limit');
  }

  const answer = await deps.review({
    host: 'connect',
    fields,
    origin: deps.origin,
    identity: identity.address,
    chainId: network.chainId,
    rpcUrl: network.rpcUrl,
    onChainOld,
  });
  return 'status' in answer && answer.status === 'Approved'
    ? { status: 'Approved', args: { ...account, ...(answer.args as object) } }
    : answer;
}

async function disconnectWithKey(deps: SessionDeps, fields: SessionRequestFields): Promise<SessionAnswer> {
  const resolved = await resolve(deps, fields);
  if (!('identity' in resolved)) return resolved;
  const { identity, network } = resolved;

  const key = decodeGpub(fields.pubkey);
  if (!(await deps.getSession(identity.address, key.address))) return rejected('session_not_found');
  return deps.review({
    host: 'disconnect',
    fields,
    origin: deps.origin,
    identity: identity.address,
    chainId: network.chainId,
    rpcUrl: network.rpcUrl,
    onChainOld: false,
  });
}

function asAnswer(error: unknown): SessionAnswer {
  if (error instanceof GnoConnectRequestError) return rejected(error.code);
  return { fail: 'tx_failed', message: (error as Error)?.message ?? String(error) };
}

/** Answers one session message. Never throws: a failure is a `SessionAnswer` too. */
export async function answerSessionMessage(
  deps: SessionDeps,
  memory: ReplayMemory,
  type: string,
  data: SessionMessageData,
): Promise<SessionAnswer> {
  const host = data?.host;
  if (host !== 'connect' && host !== 'disconnect') return rejected('invalid_request');

  if (type === GNOCONNECT_SESSION_DISCONNECT) {
    // The approval goes in every case, once the call has settled: the review
    // window still opens in the approved context.
    try {
      if (data.fields === null || data.fields === undefined) return { status: 'Approved', args: {} };
      const fields = await checked(deps, 'disconnect', data.fields);
      if (!memory.consume(fields.pubkey, fields.state, deps.clock())) return rejected('invalid_request');
      return await disconnectWithKey(deps, fields);
    } catch (error) {
      return asAnswer(error);
    } finally {
      await deps.withdrawApproval();
    }
  }

  try {
    const fields = await checked(deps, host, data.fields);
    if (type === GNOCONNECT_SESSION_CHECK) {
      // A repeat is not acted on again. In-page each call has its own promise,
      // so it is answered rather than dropped: that cannot close the first.
      return memory.check(fields.pubkey, fields.state, deps.clock())
        ? { status: 'Approved', args: {} }
        : rejected('invalid_request');
    }
    if (type === GNOCONNECT_SESSION_CONNECT && host === 'connect') {
      if (!memory.consume(fields.pubkey, fields.state, deps.clock())) return rejected('invalid_request');
      return await connectWithKey(deps, fields);
    }
    return rejected('invalid_request');
  } catch (error) {
    return asAnswer(error);
  }
}

/** The message the executor resolves with. */
export function toSessionReply(answer: SessionAnswer): Record<string, unknown> {
  return { status: 'success', type: 'GNOCONNECT_SESSION', code: 0, message: '', data: { gnoconnect: answer } };
}
