import { GnoConnectRequestError } from './errors';
import { decodeGpub } from './session-request';
import {
  ChallengeSteps,
  connectWithChallenge,
  gpubFromCompressed,
  MAX_CHALLENGE_BYTES,
  SignedText,
  validateChallenge,
} from './challenge';
import { UserResponse } from './types';

// test1, the key of gno's sign-data vectors (tm2/pkg/std/signdata_test.go).
const TEST1 = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';
const TEST1_PUB = 'A+FhNtsXHjLfSJk1lB8FbiL4mGPjc50Kt81J7EKDnJ2y';
const FEATURES = ['sendtx', 'signtx', 'multi_msg', 'sessions', 'challenge'];
const CHALLENGE = 'example.com: prove this wallet is yours · 9UQV';

const signedFor = (chainId: string): UserResponse<SignedText> => ({
  status: 'Approved',
  args: {
    signed: { chain_id: chainId, msgs: [] },
    signature: { pubKey: { value: TEST1_PUB }, signature: 'c2ln' },
  },
});

function steps(over: Partial<ChallengeSteps> = {}): ChallengeSteps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    establish: async () => (calls.push('establish'), { status: 'Approved', args: null }),
    resolveNetwork: async (chainid) => (calls.push(`network ${chainid ?? ''}`), chainid ?? 'dev'),
    currentAddress: async () => (calls.push('account'), TEST1),
    sign: async (signer, data) => (calls.push(`sign ${signer} ${data}`), signedFor('dev')),
    ...over,
  };
}

describe('validateChallenge', () => {
  it('returns the text', () => {
    expect(validateChallenge({ challenge: CHALLENGE })).toBe(CHALLENGE);
  });

  it.each([
    ['empty', { challenge: '' }],
    ['not a string', { challenge: 7 as unknown as string }],
    ['with a key', { challenge: 'a', pubkey: 'gpub1x' }],
    ['a newline', { challenge: 'a\nb' }],
    ['a tab', { challenge: 'a\tb' }],
    ['DEL', { challenge: 'a\u007fb' }],
    ['C1', { challenge: 'a\u0085b' }],
    ['one byte too many', { challenge: 'é'.repeat(MAX_CHALLENGE_BYTES / 2) + 'a' }],
  ])('refuses %s as invalid_request', (_name, opts) => {
    expect(() => validateChallenge(opts)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('counts bytes, not characters', () => {
    const text = 'é'.repeat(MAX_CHALLENGE_BYTES / 2);
    expect(validateChallenge({ challenge: text })).toBe(text);
  });
});

describe('gpubFromCompressed', () => {
  it('wraps the key as tm2 prints it: the gpub of test1', () => {
    const gpub = gpubFromCompressed(TEST1_PUB);
    expect(gpub.startsWith('gpub1')).toBe(true);
    expect(decodeGpub(gpub)).toMatchObject({ type: 'secp256k1', address: TEST1 });
  });

  it('refuses a key that is not 33 bytes', () => {
    expect(() => gpubFromCompressed('c2ln')).toThrow(expect.objectContaining({ code: 'signer_unavailable' }));
  });
});

describe('connectWithChallenge', () => {
  it('signs as the current account and answers the proof, its key and the features', async () => {
    const s = steps();
    const answer = await connectWithChallenge(s, { challenge: CHALLENGE, chainid: 'dev' }, FEATURES);
    expect(s.calls).toEqual(['establish', 'network dev', 'account', `sign ${TEST1} ${CHALLENGE}`]);
    expect(answer).toEqual({
      status: 'Approved',
      args: {
        address: TEST1,
        chainid: 'dev',
        pubkey: gpubFromCompressed(TEST1_PUB),
        features: FEATURES,
        proof: { signed: { chain_id: 'dev', msgs: [] }, signature: 'c2ln' },
      },
    });
    expect('session' in (answer as { args: object }).args).toBe(false);
  });

  it('refuses a bad challenge before any step', async () => {
    const s = steps();
    expect(await connectWithChallenge(s, { challenge: 'a\u0085b' }, FEATURES)).toEqual({
      status: 'Rejected',
      code: 'invalid_request',
    });
    expect(s.calls).toEqual([]);
  });

  it('stops when the user refuses the site', async () => {
    const s = steps({ establish: async () => ({ status: 'Rejected' }) });
    expect(await connectWithChallenge(s, { challenge: CHALLENGE }, FEATURES)).toEqual({ status: 'Rejected' });
  });

  it('answers network_declined when the network cannot be had', async () => {
    const s = steps({
      resolveNetwork: async () => {
        throw new GnoConnectRequestError('network_declined', 'no');
      },
    });
    expect(await connectWithChallenge(s, { challenge: CHALLENGE, chainid: 'other' }, FEATURES)).toEqual({
      status: 'Rejected',
      code: 'network_declined',
    });
  });

  it('refuses a pin that is not the current account, without a signature window', async () => {
    const s = steps();
    const answer = await connectWithChallenge(s, { challenge: CHALLENGE, signer: 'g1qynsu9dwj9lq0m5fkje7jh6qy3md80ztqnshhm' }, FEATURES);
    expect(answer).toEqual({ status: 'Rejected', code: 'signer_unavailable' });
    expect(s.calls.some((c) => c.startsWith('sign'))).toBe(false);
  });

  it('takes a pin in upper case for the same identity', async () => {
    const s = steps();
    const answer = await connectWithChallenge(s, { challenge: CHALLENGE, signer: TEST1.toUpperCase() }, FEATURES);
    expect(answer.status).toBe('Approved');
    expect(s.calls).toContain(`sign ${TEST1} ${CHALLENGE}`);
  });

  it('passes the refusal of the signature on, with no code', async () => {
    const s = steps({ sign: async () => ({ status: 'Rejected' }) });
    expect(await connectWithChallenge(s, { challenge: CHALLENGE }, FEATURES)).toEqual({ status: 'Rejected' });
  });

  it('answers signer_unavailable when the account signs without a key (a Ledger account)', async () => {
    const s = steps({ sign: async () => ({ status: 'Approved', args: { signed: { chain_id: 'dev' } } }) });
    expect(await connectWithChallenge(s, { challenge: CHALLENGE }, FEATURES)).toEqual({
      status: 'Rejected',
      code: 'signer_unavailable',
    });
  });

  it('answers the chain the document was signed for', async () => {
    const s = steps({ resolveNetwork: async () => 'dev', sign: async () => signedFor('test5') });
    const answer = await connectWithChallenge(s, { challenge: CHALLENGE, chainid: 'dev' }, FEATURES);
    expect(answer.status === 'Approved' && answer.args.chainid).toBe('test5');
  });

  it('lets a genuine failure through', async () => {
    const s = steps({ sign: async () => Promise.reject(Object.assign(new Error('mismatch'), { code: 'signer_unavailable' })) });
    await expect(connectWithChallenge(s, { challenge: CHALLENGE }, FEATURES)).rejects.toMatchObject({ code: 'signer_unavailable' });
  });
});
