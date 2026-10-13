/**
 * @jest-environment node
 */
// Node, not jsdom: the Ed25519 proof is checked with WebCrypto, which jsdom lacks.
import { ec as EC } from 'elliptic';
import { sha256 } from 'adena-module';

import {
  canonicalPayload,
  checkFreshness,
  decodeGpub,
  SessionRequestFields,
  validateSessionRequest,
  verifyProof,
} from './session-request';

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};
const asyncCodeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e) => (e as { code?: string }).code,
  );

// The Go reference vector (a GnoConnect producer's payload test), minus its callback line.
const GPUB =
  'gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqwy7ynrtu4aum2869uhjarjtsuer63evxrrm3d4sa3w6mkyzefv8yhklkkx';
const GO_PAYLOAD_INPAGE = [
  'gnoconnect-session-v1',
  'host=connect',
  'allow=bank/send',
  'allow=vm/exec:gno.land/r/foo',
  'chainid=dev',
  'expires=2592000',
  'iat=1790841600',
  'period=3600',
  `pubkey=${GPUB}`,
  'spend=5000000ugnot',
  'state=ab+c=',
].join('\n');

// tm2's Go for the Ed25519 seed 01..20 (the in-page sessions prototype's vector).
const ED_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ED_PUB = '79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664';
const ED_GPUB =
  'gpub1pggj7ard9eg82cjtv4u52epjx56nzwgjyg9zq7d42chglej5l9q83vgjaz5chfusr7zn4e54hmt7pcu3pwksf9ny6h7lpd';
const ED_ADDR = 'g1vkmqvu7kakyyhuqu9s3zmq4d5p6q72dvjtaurv';
// test1.
const SECP_PUB = '03e16136db171e32df489935941f056e22f89863e3739d0ab7cd49ec42839c9db2';
const SECP_GPUB =
  'gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pq0skzdkmzu0r9h6gny6eg8c9dc303xrrudee6z4he4y7cs5rnjwmyf40yaj';
const SECP_ADDR = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';
const SIGNER = SECP_ADDR;

const secp = new EC('secp256k1');
const secpKey = secp.keyFromPrivate('0101010101010101010101010101010101010101010101010101010101010101');
const secpPub = Uint8Array.from(secpKey.getPublic(true, 'array'));

function gpubOf(type: 'ed25519' | 'secp256k1', key: Uint8Array): string {
  const url = new TextEncoder().encode(type === 'ed25519' ? '/tm.PubKeyEd25519' : '/tm.PubKeySecp256k1');
  const inner = [0x0a, key.length, ...key];
  const bytes = [0x0a, url.length, ...url, 0x12, inner.length, ...inner];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { toBech32 } = require('adena-module');
  return toBech32('gpub', Uint8Array.from(bytes), Infinity);
}

const signSecp = async (data: Uint8Array): Promise<Uint8Array> => {
  const sig = secpKey.sign(Array.from(sha256(data)), { canonical: true });
  return Uint8Array.from([...sig.r.toArray('be', 32), ...sig.s.toArray('be', 32)]);
};

async function edSigner(): Promise<{ pub: Uint8Array; sign: (d: Uint8Array) => Promise<Uint8Array> }> {
  const pkcs8 = Uint8Array.from([...hex('302e020100300506032b657004220420'), ...ED_SEED]);
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  return {
    pub: Uint8Array.from(Buffer.from(jwk.x ?? '', 'base64url')),
    sign: async (d) => new Uint8Array(await crypto.subtle.sign('Ed25519', priv, d)),
  };
}

const now = 1790841600;
const grant = (pubkey: string): Omit<SessionRequestFields, 'sig'> => ({
  pubkey,
  allow: ['vm/exec:gno.land/r/foo'],
  spend: '1000000ugnot',
  period: 3600,
  expires: 86400,
  chainid: 'dev',
  state: 's1',
  iat: now,
});

async function signed(
  host: 'connect' | 'disconnect',
  fields: Omit<SessionRequestFields, 'sig'>,
  sign: (d: Uint8Array) => Promise<Uint8Array>,
): Promise<SessionRequestFields> {
  const data = new TextEncoder().encode(canonicalPayload(host, { ...fields, sig: '' }));
  return { ...fields, sig: b64url(await sign(data)) };
}

describe('canonicalPayload', () => {
  it('is the Go vector without its callback line', () => {
    const f = validateSessionRequest('connect', {
      pubkey: GPUB,
      allow: ['vm/exec:gno.land/r/foo', 'bank/send'],
      spend: '5000000ugnot',
      period: 3600,
      expires: 2592000,
      chainid: 'dev',
      state: 'ab+c=',
      iat: 1790841600,
      sig: 'AA',
    });
    expect(canonicalPayload('connect', f)).toBe(GO_PAYLOAD_INPAGE);
  });

  it('never has a callback line, and signs unknown fields', () => {
    const f = validateSessionRequest('disconnect', {
      pubkey: GPUB, chainid: 'dev', signer: SIGNER, state: 's', iat: 1, sig: 'AA',
      callback: 'https://evil.example/cb', zzz: 'later',
    });
    expect(canonicalPayload('disconnect', f)).toBe(
      ['gnoconnect-session-v1', 'host=disconnect', 'chainid=dev', 'iat=1', `pubkey=${GPUB}`,
        `signer=${SIGNER}`, 'state=s', 'zzz=later'].join('\n'),
    );
  });
});

describe('decodeGpub', () => {
  it('reads an Ed25519 key and its address', () => {
    const k = decodeGpub(ED_GPUB);
    expect(k.type).toBe('ed25519');
    expect(Buffer.from(k.key).toString('hex')).toBe(ED_PUB);
    expect(k.address).toBe(ED_ADDR);
  });

  it('reads a secp256k1 key and its address', () => {
    const k = decodeGpub(SECP_GPUB);
    expect(k.type).toBe('secp256k1');
    expect(Buffer.from(k.key).toString('hex')).toBe(SECP_PUB);
    expect(k.address).toBe(SECP_ADDR);
  });

  it('refuses what is not a gpub key', () => {
    expect(codeOf(() => decodeGpub(SECP_ADDR))).toBe('invalid_request');
    expect(codeOf(() => decodeGpub('gpub1xyz'))).toBe('invalid_request');
  });
});

describe('validateSessionRequest', () => {
  const ok = { ...grant(SECP_GPUB), sig: 'AA' };
  const bad = (host: 'connect' | 'disconnect', input: unknown): string | undefined =>
    codeOf(() => validateSessionRequest(host, input));

  it('accepts a grant', () => {
    expect(validateSessionRequest('connect', ok).pubkey).toBe(SECP_GPUB);
  });

  it.each([
    ['no pubkey', { ...ok, pubkey: undefined }],
    ['a malformed pubkey', { ...ok, pubkey: 'gpub1nope' }],
    ['no allow', { ...ok, allow: [] }],
    ['nine allow entries', { ...ok, allow: Array(9).fill('bank/send') }],
    ['an allow entry the chain rejects', { ...ok, allow: ['vm/call:gno.land/r/x'] }],
    ['a bad spend', { ...ok, spend: '0ugnot' }],
    ['period out of range', { ...ok, period: 2592001 }],
    ['a fractional period', { ...ok, period: 1.5 }],
    ['no expires', { ...ok, expires: undefined }],
    ['expires out of range', { ...ok, expires: 126144001 }],
    ['expires 0', { ...ok, expires: 0 }],
    ['no chainid', { ...ok, chainid: '' }],
    ['no state', { ...ok, state: undefined }],
    ['a state over 256 characters', { ...ok, state: 'x'.repeat(257) }],
    ['no iat', { ...ok, iat: undefined }],
    ['an iat that is a string', { ...ok, iat: String(now) }],
    ['no sig', { ...ok, sig: undefined }],
    ['a sig that is not base64url', { ...ok, sig: 'a+b/' }],
    ['a malformed signer', { ...ok, signer: 'g1nope' }],
    ['old equal to pubkey', { ...ok, old: SECP_GPUB, signer: SIGNER, oldsig: 'AA' }],
    ['old without signer', { ...ok, old: ED_GPUB, oldsig: 'AA' }],
    ['old without oldsig', { ...ok, old: ED_GPUB, signer: SIGNER }],
    ['a control character', { ...ok, state: 'a\u0085b' }],
    ['an unknown field that is an object', { ...ok, zzz: { a: 1 } }],
  ])('refuses %s with invalid_request', (_why, input) => {
    expect(bad('connect', input)).toBe('invalid_request');
  });

  it('refuses a disconnect without chainid, signer, state, iat or sig', () => {
    const d = { pubkey: SECP_GPUB, chainid: 'dev', signer: SIGNER, state: 's', iat: now, sig: 'AA' };
    expect(validateSessionRequest('disconnect', d).signer).toBe(SIGNER);
    for (const k of ['chainid', 'signer', 'state', 'iat', 'sig'] as const) {
      expect(bad('disconnect', { ...d, [k]: undefined })).toBe('invalid_request');
    }
  });

  it('signs the grant fields a disconnect carries, as the launch link does', () => {
    const d = validateSessionRequest('disconnect', {
      pubkey: SECP_GPUB, chainid: 'dev', signer: SIGNER, state: 's', iat: now, sig: 'AA', allow: ['bank/send'],
    });
    expect(canonicalPayload('disconnect', d)).toContain('\nallow=bank/send\n');
  });

  it('drops the grant fields of a disconnect', () => {
    const d = validateSessionRequest('disconnect', {
      pubkey: SECP_GPUB, chainid: 'dev', signer: SIGNER, state: 's', iat: now, sig: 'AA', allow: ['bank/send'],
    });
    expect(d.allow).toBeUndefined();
  });

  it('refuses what is not an object', () => {
    expect(bad('connect', null)).toBe('invalid_request');
    expect(bad('connect', 'pubkey=x')).toBe('invalid_request');
  });
});

describe('verifyProof', () => {
  it('accepts a secp256k1 proof', async () => {
    const f = await signed('connect', grant(gpubOf('secp256k1', secpPub)), signSecp);
    await expect(verifyProof('connect', f)).resolves.toBeUndefined();
  });

  it('accepts an Ed25519 proof', async () => {
    const ed = await edSigner();
    expect(gpubOf('ed25519', ed.pub)).toBe(ED_GPUB);
    const f = await signed('connect', grant(ED_GPUB), ed.sign);
    await expect(verifyProof('connect', f)).resolves.toBeUndefined();
  });

  it('refuses a tampered field', async () => {
    const ed = await edSigner();
    const f = await signed('connect', grant(ED_GPUB), ed.sign);
    expect(await asyncCodeOf(verifyProof('connect', { ...f, spend: '9000000ugnot' }))).toBe('invalid_proof');
    const s = await signed('connect', grant(gpubOf('secp256k1', secpPub)), signSecp);
    expect(await asyncCodeOf(verifyProof('connect', { ...s, expires: 86401 }))).toBe('invalid_proof');
  });

  it('refuses a connect proof checked as a disconnect', async () => {
    const d = { pubkey: ED_GPUB, chainid: 'dev', signer: SIGNER, state: 's', iat: now };
    const ed = await edSigner();
    const f = await signed('connect', d, ed.sign);
    expect(await asyncCodeOf(verifyProof('disconnect', f))).toBe('invalid_proof');
  });

  it('refuses a proof made over a launch link (its callback line)', async () => {
    const ed = await edSigner();
    const fields = grant(ED_GPUB);
    const [prefix, host, ...lines] = canonicalPayload('connect', { ...fields, sig: '' }).split('\n');
    const linkPayload = [prefix, host, ...[...lines, 'callback=https://example.com/cb'].sort()].join('\n');
    const sig = b64url(await ed.sign(new TextEncoder().encode(linkPayload)));
    expect(await asyncCodeOf(verifyProof('connect', { ...fields, sig }))).toBe('invalid_proof');
  });

  it('refuses a high-S secp256k1 signature', async () => {
    const f = await signed('connect', grant(gpubOf('secp256k1', secpPub)), async (d) => {
      const low = await signSecp(d);
      const s = BigInt('0x' + Buffer.from(low.slice(32)).toString('hex'));
      const hs = (BigInt('0x' + secp.n?.toString(16)) - s).toString(16).padStart(64, '0');
      return Uint8Array.from([...low.slice(0, 32), ...hex(hs)]);
    });
    expect(await asyncCodeOf(verifyProof('connect', f))).toBe('invalid_proof');
  });

  it('checks oldsig against old', async () => {
    const ed = await edSigner();
    const fields = { ...grant(gpubOf('secp256k1', secpPub)), old: ED_GPUB, signer: SIGNER };
    const data = new TextEncoder().encode(canonicalPayload('connect', { ...fields, sig: '' }));
    const sig = b64url(await signSecp(data));
    const good = { ...fields, sig, oldsig: b64url(await ed.sign(data)) };
    await expect(verifyProof('connect', good)).resolves.toBeUndefined();
    expect(await asyncCodeOf(verifyProof('connect', { ...good, oldsig: sig }))).toBe('invalid_proof');
  });
});

describe('checkFreshness', () => {
  it('accepts up to 10 minutes old and 1 minute ahead', () => {
    expect(() => checkFreshness(now - 600, now)).not.toThrow();
    expect(() => checkFreshness(now + 60, now)).not.toThrow();
  });

  it('refuses 11 minutes old or 2 minutes ahead', () => {
    expect(codeOf(() => checkFreshness(now - 660, now))).toBe('stale_request');
    expect(codeOf(() => checkFreshness(now + 120, now))).toBe('stale_request');
  });
});
