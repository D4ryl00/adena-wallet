import { buildSessionMessages, composeNow, reviewModel } from './session-tx';

const ED_GPUB =
  'gpub1pggj7ard9eg82cjtv4u52epjx56nzwgjyg9zq7d42chglej5l9q83vgjaz5chfusr7zn4e54hmt7pcu3pwksf9ny6h7lpd';
const ED_ADDR = 'g1vkmqvu7kakyyhuqu9s3zmq4d5p6q72dvjtaurv';
const SECP_GPUB =
  'gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pq0skzdkmzu0r9h6gny6eg8c9dc303xrrudee6z4he4y7cs5rnjwmyf40yaj';
const SECP_ADDR = 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5';
const IDENTITY = 'g1identity';
const NOW = 1790841600;

const grant = {
  pubkey: ED_GPUB,
  allow: ['vm/exec:gno.land/r/demo/game', 'bank/send'],
  spend: '5000000ugnot',
  period: 3600,
  expires: 86400,
  chainid: 'dev',
  state: 's',
  iat: NOW,
  sig: 'AA',
};

describe('buildSessionMessages', () => {
  it('creates the session, expiring `expires` seconds from now', () => {
    const msgs = buildSessionMessages({ host: 'connect', fields: grant, identity: IDENTITY, onChainOld: false }, NOW);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('/auth.m_create_session');
    expect(msgs[0].value).toMatchObject({
      creator: IDENTITY,
      expires_at: String(NOW + 86400),
      allow_paths: grant.allow,
      spend_limit: '5000000ugnot',
      spend_period: '3600',
    });
    expect((msgs[0].value as { session_key: { type_url: string } }).session_key.type_url).toBe('/tm.PubKeyEd25519');
  });

  it('revokes old first when it is still on chain', () => {
    const fields = { ...grant, old: SECP_GPUB, signer: IDENTITY, oldsig: 'AA' };
    const msgs = buildSessionMessages({ host: 'connect', fields, identity: IDENTITY, onChainOld: true }, NOW);
    expect(msgs.map((m) => m.type)).toEqual(['/auth.m_revoke_session', '/auth.m_create_session']);
    expect((msgs[0].value as { session_key: { type_url: string } }).session_key.type_url).toBe('/tm.PubKeySecp256k1');
  });

  it('does not revoke an old key that is gone', () => {
    const fields = { ...grant, old: SECP_GPUB, signer: IDENTITY, oldsig: 'AA' };
    const msgs = buildSessionMessages({ host: 'connect', fields, identity: IDENTITY, onChainOld: false }, NOW);
    expect(msgs.map((m) => m.type)).toEqual(['/auth.m_create_session']);
  });

  it('defaults an absent spend to none and period to 0', () => {
    const { spend, period, ...rest } = grant;
    void spend;
    void period;
    const msgs = buildSessionMessages({ host: 'connect', fields: rest, identity: IDENTITY, onChainOld: false }, NOW);
    expect(msgs[0].value).toMatchObject({ spend_limit: '', spend_period: '0' });
  });

  it('revokes the key for a disconnect', () => {
    const fields = { pubkey: SECP_GPUB, chainid: 'dev', signer: IDENTITY, state: 's', iat: NOW, sig: 'AA' };
    const msgs = buildSessionMessages({ host: 'disconnect', fields, identity: IDENTITY, onChainOld: false }, NOW);
    expect(msgs.map((m) => m.type)).toEqual(['/auth.m_revoke_session']);
    expect(msgs[0].value).toMatchObject({ creator: IDENTITY });
  });
});

describe('composeNow', () => {
  it('is the latest block time, never later than the clock', () => {
    expect(composeNow(NOW - 5, NOW)).toBe(NOW - 5);
    expect(composeNow(NOW + 30, NOW)).toBe(NOW);
  });

  it('is null without a usable block time', () => {
    expect(composeNow(null, NOW)).toBeNull();
    expect(composeNow(0, NOW)).toBeNull();
  });
});

describe('reviewModel', () => {
  it('states the budget per period and its worst case over the lifetime', () => {
    const m = reviewModel(grant, false);
    expect(m.budget).toBe('5 GNOT per 1 hour');
    expect(m.worstCase).toBe('at most 120 GNOT over 1 day');
  });

  it('states a lifetime cap with period 0, and no spending without spend', () => {
    expect(reviewModel({ ...grant, period: 0 }, false).budget).toBe('5 GNOT in total');
    expect(reviewModel({ ...grant, period: 0 }, false).worstCase).toBe('at most 5 GNOT over 1 day');
    const { spend, ...noSpend } = grant;
    void spend;
    expect(reviewModel(noSpend, false).budget).toBe('cannot spend, not even its own gas');
    expect(reviewModel(noSpend, false).worstCase).toBe('');
  });

  it('flags the risky entries', () => {
    const m = reviewModel({ ...grant, allow: ['*', 'vm/exec', 'vm/exec:gno.land/r/x', 'vm/run', 'bank/send', 'bank/multisend'] }, false);
    expect(m.risky).toEqual(['*', 'vm/exec', 'vm/run', 'bank/send', 'bank/multisend']);
  });

  it('shows old and new keys for a renewal', () => {
    const fields = { ...grant, pubkey: SECP_GPUB, old: ED_GPUB, signer: IDENTITY, oldsig: 'AA' };
    expect(reviewModel(fields, true).keys).toEqual([
      { label: 'Old key', value: `${ED_ADDR} (revoked in this transaction)` },
      { label: 'New key', value: SECP_ADDR },
    ]);
    expect(reviewModel(fields, false).keys[0].value).toBe(`${ED_ADDR} (no longer on chain: nothing is replaced)`);
    expect(reviewModel(grant, false).keys).toEqual([{ label: 'Key', value: ED_ADDR }]);
  });
});
