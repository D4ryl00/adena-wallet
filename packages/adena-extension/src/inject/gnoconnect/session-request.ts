// A GnoConnect session request made in-page: `connect(opts)` naming a key, or
// `disconnect(req)`. Same fields, rules, payload and proof as the launch link
// (gnoconnect.md, "Sessions"), except that the payload never has a `callback`
// line: the answer goes back to the calling page and cannot be redirected.
import { ec as EC } from 'elliptic';
import { fromBech32, ripemd160, sha256, toBech32 } from 'adena-module';

import { validateAllowPaths, validateSpendLimit } from '@services/transaction/message/auth/auth';

import { GnoConnectRequestError } from './errors';

export type SessionHost = 'connect' | 'disconnect';

/** A field the standard does not define yet: signed, then ignored. */
export type ExtraField = string | number | string[];

export interface SessionRequestFields {
  pubkey: string;
  old?: string;
  allow?: string[];
  spend?: string;
  period?: number;
  expires?: number;
  chainid: string;
  rpc?: string;
  signer?: string;
  state: string;
  iat: number;
  sig: string;
  oldsig?: string;
  extra?: Record<string, ExtraField>;
}

export interface DecodedKey {
  type: 'ed25519' | 'secp256k1';
  key: Uint8Array;
  address: string;
}

const MAX_STATE_LEN = 256;
const MAX_ALLOW = 8;
const MAX_PERIOD = 2_592_000;
const MAX_EXPIRES = 126_144_000;
const MAX_AGE = 600;
const MAX_AHEAD = 60;

const KEY_TYPES: Record<string, { type: DecodedKey['type']; size: number }> = {
  '/tm.PubKeyEd25519': { type: 'ed25519', size: 32 },
  '/tm.PubKeySecp256k1': { type: 'secp256k1', size: 33 },
};

const invalid = (message: string): GnoConnectRequestError =>
  new GnoConnectRequestError('invalid_request', message);

/** Control characters as Go's unicode.IsControl sees them: C0, DEL and C1. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Reads `gpub1…`: bech32 of the amino Any { type_url, value: { key } }. */
export function decodeGpub(gpub: string): DecodedKey {
  let data: Uint8Array;
  try {
    const decoded = fromBech32(gpub);
    if (decoded.prefix !== 'gpub') throw new Error(`prefix ${decoded.prefix}`);
    data = decoded.data;
  } catch (e) {
    throw invalid(`pubkey ${gpub}: ${(e as Error).message}`);
  }
  // 0x0a len type_url 0x12 len (0x0a len key)
  const urlLen = data[1];
  const url = new TextDecoder().decode(data.slice(2, 2 + urlLen));
  const t = KEY_TYPES[url];
  const rest = data.slice(2 + urlLen);
  if (
    data[0] !== 0x0a ||
    !t ||
    rest[0] !== 0x12 ||
    rest[1] !== t.size + 2 ||
    rest[2] !== 0x0a ||
    rest[3] !== t.size ||
    rest.length !== t.size + 4
  ) {
    throw invalid(`pubkey ${gpub} is not an Ed25519 or secp256k1 key`);
  }
  const key = rest.slice(4);
  const hash = t.type === 'ed25519' ? sha256(key).slice(0, 20) : ripemd160(sha256(key));
  return { type: t.type, key, address: toBech32('g', hash) };
}

/** Bytewise UTF-8 order, which is code-point order (UTF-16 code units disagree above U+FFFF). */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

/**
 * The proof-of-possession payload: every field but `sig` and `oldsig`, numbers
 * in decimal, `allow` one line per entry, absent fields omitted, sorted by key
 * then value in code-point order.
 */
export function canonicalPayload(host: SessionHost, f: SessionRequestFields): string {
  const named: Record<string, ExtraField | undefined> = {
    pubkey: f.pubkey,
    old: f.old,
    allow: f.allow,
    spend: f.spend,
    period: f.period,
    expires: f.expires,
    chainid: f.chainid,
    rpc: f.rpc,
    signer: f.signer,
    state: f.state,
    iat: f.iat,
  };
  const kvs: [string, string][] = [];
  // validateSessionRequest never puts a named field in `extra`.
  for (const [k, v] of [...Object.entries(named), ...Object.entries(f.extra ?? {})]) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) kvs.push([k, String(one)]);
  }
  kvs.sort(([ak, av], [bk, bv]) => byCodePoint(ak, bk) || byCodePoint(av, bv));
  return ['gnoconnect-session-v1', `host=${host}`, ...kvs.map(([k, v]) => `${k}=${v}`)].join('\n');
}

const NAMED = new Set([
  'pubkey', 'old', 'allow', 'spend', 'period', 'expires', 'chainid', 'rpc', 'signer', 'state', 'iat',
  'sig', 'oldsig',
]);
const DISCONNECT_NAMED = new Set(['pubkey', 'chainid', 'rpc', 'signer', 'state', 'iat', 'sig', 'oldsig']);

function optStr(input: Record<string, unknown>, k: string): string | undefined {
  const v = input[k];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw invalid(`${k} must be a string`);
  return v;
}

function reqStr(input: Record<string, unknown>, k: string): string {
  const v = optStr(input, k);
  if (v === undefined) throw invalid(`${k} is required`);
  return v;
}

function optInt(input: Record<string, unknown>, k: string): number | undefined {
  const v = input[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalid(`${k} must be an integer`);
  return v;
}

function reqInt(input: Record<string, unknown>, k: string): number {
  const v = optInt(input, k);
  if (v === undefined) throw invalid(`${k} is required`);
  return v;
}

function checkSig(k: string, v: string | undefined): string | undefined {
  if (v !== undefined && !BASE64URL.test(v)) throw invalid(`${k} is not base64url without padding`);
  return v;
}

/**
 * Reads what a page passed to `connect(opts)` (with `pubkey`) or
 * `disconnect(req)`, by the launch link's parameters table. Unknown fields are
 * kept for the payload; `callback` is dropped, it has no meaning in-page.
 */
export function validateSessionRequest(host: SessionHost, input: unknown): SessionRequestFields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('the request must be an object');
  }
  const o = input as Record<string, unknown>;

  // A disconnect's grant fields are signed like unknown ones, then ignored (as
  // the launch link drops them after building the payload).
  const named = host === 'connect' ? NAMED : DISCONNECT_NAMED;
  const extra: Record<string, ExtraField> = {};
  for (const [k, v] of Object.entries(o)) {
    if (named.has(k) || k === 'callback' || v === undefined) continue;
    if (k.includes('=')) throw invalid(`= in the field name ${k}`);
    const ok =
      typeof v === 'string' ||
      (typeof v === 'number' && Number.isSafeInteger(v)) ||
      (Array.isArray(v) && v.every((e) => typeof e === 'string'));
    if (!ok) throw invalid(`${k} must be a string, an integer or a list of strings`);
    extra[k] = v as ExtraField;
  }

  const f: SessionRequestFields = {
    pubkey: reqStr(o, 'pubkey'),
    chainid: reqStr(o, 'chainid'),
    rpc: optStr(o, 'rpc'),
    signer: host === 'disconnect' ? reqStr(o, 'signer') : optStr(o, 'signer'),
    state: reqStr(o, 'state'),
    iat: reqInt(o, 'iat'),
    sig: reqStr(o, 'sig'),
  };
  checkSig('sig', f.sig);
  if (Object.keys(extra).length) f.extra = extra;

  for (const [k, v] of Object.entries(o)) {
    const values = Array.isArray(v) ? v : [v];
    if (values.some((e) => typeof e === 'string' && CONTROL.test(e)) || CONTROL.test(k)) {
      throw invalid(`control character in ${k}`);
    }
  }
  decodeGpub(f.pubkey);
  if (f.state.length > MAX_STATE_LEN) throw invalid(`state is longer than ${MAX_STATE_LEN} characters`);
  if (f.signer !== undefined) {
    let prefix = '';
    let length = 0;
    try {
      const d = fromBech32(f.signer);
      prefix = d.prefix;
      length = d.data.length;
    } catch {
      // reported below
    }
    if (prefix !== 'g' || length !== 20) throw invalid(`signer ${f.signer} is not an address`);
  }

  if (host === 'disconnect') return f; // the grant fields mean nothing here

  const allow = o.allow;
  if (!Array.isArray(allow) || !allow.every((e) => typeof e === 'string')) {
    throw invalid('allow must be a list of entries');
  }
  if (allow.length < 1 || allow.length > MAX_ALLOW) throw invalid(`allow needs 1 to ${MAX_ALLOW} entries`);
  try {
    validateAllowPaths(allow);
  } catch (e) {
    throw invalid(`allow: ${(e as Error).message}`);
  }
  f.allow = allow;

  f.spend = optStr(o, 'spend');
  if (f.spend !== undefined) {
    try {
      validateSpendLimit(f.spend);
    } catch (e) {
      throw invalid((e as Error).message);
    }
  }
  f.period = optInt(o, 'period');
  if (f.period !== undefined && (f.period < 0 || f.period > MAX_PERIOD)) {
    throw invalid(`period: want 0 to ${MAX_PERIOD} seconds`);
  }
  const expires = reqInt(o, 'expires');
  if (expires < 1 || expires > MAX_EXPIRES) throw invalid(`expires: want 1 to ${MAX_EXPIRES} seconds`);
  f.expires = expires;

  f.old = optStr(o, 'old');
  f.oldsig = checkSig('oldsig', optStr(o, 'oldsig'));
  if (f.old !== undefined) {
    decodeGpub(f.old);
    if (f.old === f.pubkey) throw invalid('old must differ from pubkey');
    if (!f.signer) throw invalid('old needs signer');
    if (!f.oldsig) throw invalid('old needs oldsig');
  } else if (f.oldsig !== undefined) {
    throw invalid('oldsig comes with old');
  }
  return f;
}

const base64urlDecode = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

const secp256k1 = new EC('secp256k1');

async function verifies(key: DecodedKey, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (sig.length !== 64) return false;
  if (key.type === 'ed25519') {
    const pub = await crypto.subtle.importKey('raw', key.key, { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, data);
  }
  // tm2's VerifyBytes: R‖S over SHA-256, and S in the lower half.
  const r = sig.slice(0, 32);
  const s = sig.slice(32);
  const sInt = BigInt('0x' + Array.from(s, (b) => b.toString(16).padStart(2, '0')).join(''));
  if (sInt === BigInt(0) || sInt > BigInt('0x' + secp256k1.nh.toString(16))) return false;
  try {
    return secp256k1.keyFromPublic(Array.from(key.key)).verify(Array.from(sha256(data)), {
      r: Array.from(r),
      s: Array.from(s),
    } as unknown as EC.Signature);
  } catch {
    return false;
  }
}

/** `sig` against `pubkey` and, with `old`, `oldsig` against `old`; both over the same payload. */
export async function verifyProof(host: SessionHost, f: SessionRequestFields): Promise<void> {
  const data = new TextEncoder().encode(canonicalPayload(host, f));
  const proofs: [string, string | undefined][] = [[f.pubkey, f.sig]];
  if (f.old) proofs.push([f.old, f.oldsig]);
  for (const [gpub, sig] of proofs) {
    if (!sig || !(await verifies(decodeGpub(gpub), data, base64urlDecode(sig)))) {
      throw new GnoConnectRequestError('invalid_proof', `the proof by ${gpub} does not verify`);
    }
  }
}

/** `iat` at most 10 minutes old and 1 minute ahead of `nowSec`. */
export function checkFreshness(iat: number, nowSec: number): void {
  if (nowSec - iat > MAX_AGE || iat - nowSec > MAX_AHEAD) {
    throw new GnoConnectRequestError('stale_request', `iat ${iat} is outside the window around ${nowSec}`);
  }
}
