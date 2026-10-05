// What the review window of a session request composes and shows: the `auth`
// messages, the time they count from, and the grant in plain terms.
import {
  createMessageOfCreateSession,
  createMessageOfRevokeSession,
} from '@services/transaction/message/auth/auth';

import { decodeGpub, SessionHost, SessionRequestFields } from './session-request';
import { GnoSessionAnswer } from './types';

export interface SessionTxRequest {
  host: SessionHost;
  fields: SessionRequestFields;
  identity: string;
  onChainOld: boolean;
}

export type SessionMessage = { type: string; value: unknown };

/**
 * `connect`: revoke `old` if it is still on chain, then create the session,
 * expiring `expires` seconds after `nowSec`. `disconnect`: revoke the key.
 * Both under the identity, which signs.
 */
export function buildSessionMessages(request: SessionTxRequest, nowSec: number): SessionMessage[] {
  const { fields, identity } = request;
  if (request.host === 'disconnect') {
    return [createMessageOfRevokeSession({ creator: identity, sessionPublicKey: decodeGpub(fields.pubkey) })];
  }
  const messages: SessionMessage[] = [];
  if (fields.old && request.onChainOld) {
    messages.push(createMessageOfRevokeSession({ creator: identity, sessionPublicKey: decodeGpub(fields.old) }));
  }
  messages.push(
    createMessageOfCreateSession({
      creator: identity,
      sessionPublicKey: decodeGpub(fields.pubkey),
      expiresAt: nowSec + (fields.expires ?? 0),
      allowPaths: fields.allow ?? [],
      spendLimit: fields.spend ?? '',
      spendPeriod: fields.period ?? 0,
    }),
  );
  return messages;
}

/** A session as the chain holds it. */
export interface ChainSession {
  expiresAt: number;
  allow: string[];
  spend: string;
  period: number;
}

/**
 * What the sent transaction did, read from the chain until it shows: the
 * session for `connect`, its absence for `disconnect`. A read that fails proves
 * neither. `tries` reads, with `wait` between two.
 */
export async function readBack(
  request: SessionTxRequest,
  read: (master: string, session: string) => Promise<ChainSession | null>,
  wait: () => Promise<void>,
  tries: number,
): Promise<GnoSessionAnswer> {
  const key = decodeGpub(request.fields.pubkey).address;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await wait();
    let session: ChainSession | null;
    try {
      session = await read(request.identity, key);
    } catch {
      continue;
    }
    if (request.host === 'disconnect' && !session) {
      return { status: 'Approved', args: { revoked: key } };
    }
    if (request.host === 'connect' && session) {
      const { fields, onChainOld } = request;
      const revoked = fields.old && onChainOld ? decodeGpub(fields.old).address : undefined;
      return { status: 'Approved', args: { session: key, ...session, ...(revoked ? { revoked } : {}) } };
    }
  }
  return { fail: 'tx_failed', message: 'The transaction was sent, but its effect never showed on the node' };
}

/** The latest block time, never later than the clock; null without a usable one. */
export function composeNow(blockTimeSec: number | null, clockSec: number): number | null {
  if (!blockTimeSec || blockTimeSec <= 0) return null;
  return Math.min(blockTimeSec, clockSec);
}

const RISKY = new Set(['*', 'vm/exec', 'vm/run', 'bank/send', 'bank/multisend']);

function duration(seconds: number): string {
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function coins(spend: string, times: number): string {
  return spend
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => {
      const match = entry.match(/^([0-9]+)\s*([a-z/][a-z0-9_.:/]{2,})$/);
      if (!match) return entry;
      const amount = BigInt(match[1]) * BigInt(times);
      if (match[2] !== 'ugnot') return `${amount}${match[2]}`;
      const whole = amount / BigInt(1_000_000);
      const frac = (amount % BigInt(1_000_000)).toString().padStart(6, '0').replace(/0+$/, '');
      return `${whole}${frac ? `.${frac}` : ''} GNOT`;
    })
    .join(' + ');
}

export interface ReviewModel {
  budget: string;
  worstCase: string;
  risky: string[];
  keys: { label: string; value: string }[];
}

/** The grant as the review shows it (gnoconnect.md, "Review"). */
export function reviewModel(fields: Omit<SessionRequestFields, 'sig'> & { sig?: string }, onChainOld: boolean): ReviewModel {
  const expires = fields.expires ?? 0;
  const period = fields.period ?? 0;
  let budget = 'cannot spend, not even its own gas';
  let worstCase = '';
  if (fields.spend) {
    if (period > 0) {
      budget = `${coins(fields.spend, 1)} per ${duration(period)}`;
      worstCase = `at most ${coins(fields.spend, Math.ceil(expires / period))} over ${duration(expires)}`;
    } else {
      budget = `${coins(fields.spend, 1)} in total`;
      worstCase = `at most ${coins(fields.spend, 1)} over ${duration(expires)}`;
    }
  }
  const key = decodeGpub(fields.pubkey).address;
  const keys = fields.old
    ? [
        {
          label: 'Old key',
          value: `${decodeGpub(fields.old).address} ${
            onChainOld ? '(revoked in this transaction)' : '(no longer on chain: nothing is replaced)'
          }`,
        },
        { label: 'New key', value: key },
      ]
    : [{ label: 'Key', value: key }];
  return { budget, worstCase, risky: (fields.allow ?? []).filter((entry) => RISKY.has(entry)), keys };
}
