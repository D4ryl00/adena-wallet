// Scope hints on a `connect` without a key: validated as a grant would be,
// then ignored — Adena does not pick or create sessions of its own from them.
import { validateAllowPaths, validateSpendLimit } from '@services/transaction/message/auth/auth';

import { GnoConnectRequestError } from './errors';
import { GnoConnectOptions } from './types';

const MAX_PERIOD = 2_592_000;
const MAX_EXPIRES = 126_144_000;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Throws `invalid_request` for hints a grant with the same values would be refused for. */
export function validateScopeHints(opts: GnoConnectOptions): void {
  const bad = (why: string): never => {
    throw new GnoConnectRequestError('invalid_request', why);
  };
  const { allow, spend, period, expires } = opts;
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.length < 1 || allow.length > 8) bad('allow needs 1 to 8 entries');
    try {
      validateAllowPaths(allow);
    } catch (e) {
      bad(`allow: ${(e as Error).message}`);
    }
  }
  if (spend !== undefined) {
    if (typeof spend !== 'string') bad('spend must be a string');
    try {
      validateSpendLimit(spend);
    } catch (e) {
      bad((e as Error).message);
    }
  }
  if (period !== undefined && (!isInt(period) || period < 0 || period > MAX_PERIOD)) {
    bad(`period: want 0 to ${MAX_PERIOD} seconds`);
  }
  if (expires !== undefined && (!isInt(expires) || expires < 1 || expires > MAX_EXPIRES)) {
    bad(`expires: want 1 to ${MAX_EXPIRES} seconds`);
  }
}
