import { createMessageOfCreateSession, createMessageOfRevokeSession } from './auth';

const baseInfo = {
  creator: 'g1masteraddress',
  sessionPublicKey: new Uint8Array(33).fill(1),
  expiresAt: 1,
  spendLimit: '1ugnot',
  spendPeriod: 0,
};

const createWithAllowPaths = (allowPaths: string[]): ReturnType<typeof createMessageOfCreateSession> => {
  return createMessageOfCreateSession({
    ...baseInfo,
    allowPaths,
  });
};

describe('createMessageOfCreateSession allow_paths validation', () => {
  it('allows chain-whitelisted route/type entries without realm lookup paths', () => {
    const allowPaths = ['vm/exec', 'vm/run', 'bank/send', 'bank/multisend'];

    const message = createWithAllowPaths(allowPaths);

    expect(message.value.allow_paths).toEqual(allowPaths);
  });

  it('allows vm/exec entries with a realm path suffix', () => {
    const allowPaths = ['vm/exec:gno.land/r/demo'];

    const message = createWithAllowPaths(allowPaths);

    expect(message.value.allow_paths).toEqual(allowPaths);
  });

  it('returns JSON-safe session integer fields', () => {
    const message = createMessageOfCreateSession({
      ...baseInfo,
      expiresAt: BigInt('1779436464'),
      spendPeriod: BigInt(60),
      allowPaths: ['bank/send'],
    });

    expect(message.value.expires_at).toBe('1779436464');
    expect(message.value.spend_period).toBe('60');
    expect(() => JSON.stringify(message)).not.toThrow();
  });

  it('rejects bare routes and unknown route/type entries', () => {
    expect(() => createWithAllowPaths(['vm'])).toThrow(
      'must be one of *, vm/exec, vm/run, bank/send, bank/multisend',
    );
    expect(() => createWithAllowPaths(['bank'])).toThrow(
      'must be one of *, vm/exec, vm/run, bank/send, bank/multisend',
    );
  });

  it('rejects path suffixes outside vm/exec', () => {
    expect(() => createWithAllowPaths(['bank/send:gno.land/r/demo'])).toThrow(
      'can only include a path after vm/exec',
    );
  });

  it('rejects empty vm/exec path suffixes', () => {
    expect(() => createWithAllowPaths(['vm/exec:'])).toThrow('requires a non-empty path');
  });
});

describe('session keys', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ec: EC } = require('elliptic');
  const point = new EC('secp256k1').keyFromPrivate('01'.repeat(32)).getPublic();
  const compressed = Uint8Array.from(point.encode('array', true));
  const uncompressed = Uint8Array.from(point.encode('array', false));
  const ed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

  type SessionKey = Parameters<typeof createMessageOfCreateSession>[0]['sessionPublicKey'];
  type WrappedKey = ReturnType<typeof createMessageOfCreateSession>['value']['session_key'];
  const create = (sessionPublicKey: SessionKey): WrappedKey =>
    createMessageOfCreateSession({ ...baseInfo, sessionPublicKey, allowPaths: ['bank/send'] }).value.session_key;

  it('wraps an Ed25519 key as /tm.PubKeyEd25519', () => {
    const any = create({ type: 'ed25519', key: ed, address: 'g1x' });
    expect(any.type_url).toBe('/tm.PubKeyEd25519');
    expect(hex(any.value)).toBe('0a20' + hex(ed));
  });

  it('keeps a bare 33-byte key as secp256k1, bytes unchanged', () => {
    const any = create(compressed);
    expect(any.type_url).toBe('/tm.PubKeySecp256k1');
    expect(hex(any.value)).toBe('0a21' + hex(compressed));
    expect(hex(create({ type: 'secp256k1', key: compressed, address: 'g1x' }).value)).toBe('0a21' + hex(compressed));
  });

  it('still compresses a 65-byte key first', () => {
    expect(hex(create(uncompressed).value)).toBe('0a21' + hex(compressed));
  });

  it('revokes an Ed25519 key with the same encoding', () => {
    const any = createMessageOfRevokeSession({
      creator: 'g1master',
      sessionPublicKey: { type: 'ed25519', key: ed, address: 'g1x' },
    }).value.session_key;
    expect(any.type_url).toBe('/tm.PubKeyEd25519');
    expect(hex(any.value)).toBe('0a20' + hex(ed));
  });
});
