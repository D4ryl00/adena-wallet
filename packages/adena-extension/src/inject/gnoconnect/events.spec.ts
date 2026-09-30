import { createProviderEvents, Peek } from './events';
import { GNO_STATE_HINT_EVENT, GnoAccount, GnoNetwork } from './types';

const alice: GnoAccount = { address: 'g1alice', chainid: 'dev', pubkey: null };
const bob: GnoAccount = { address: 'g1bob', chainid: 'dev', pubkey: null };
const dev: GnoNetwork = { chainid: 'dev', rpc: 'http://127.0.0.1:26657', name: 'Local' };
const test5: GnoNetwork = {
  chainid: 'test5',
  rpc: 'https://rpc.test5.gno.land',
  name: 'Testnet 5',
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Wallet state the peeks read; tests mutate it, then hint. */
function setup(): {
  state: { account: Peek<GnoAccount>; network: Peek<GnoNetwork> };
  target: EventTarget;
  events: ReturnType<typeof createProviderEvents>;
  hint: () => Promise<void>;
  reads: () => number;
} {
  const state: { account: Peek<GnoAccount>; network: Peek<GnoNetwork> } = {
    account: { value: alice },
    network: { value: dev },
  };
  let count = 0;
  const target = new EventTarget();
  const events = createProviderEvents(
    async () => {
      count++;
      return state.account;
    },
    async () => state.network,
    target,
  );
  const hint = async (): Promise<void> => {
    target.dispatchEvent(new Event(GNO_STATE_HINT_EVENT));
    await flush();
  };
  return { state, target, events, hint, reads: () => count };
}

describe('createProviderEvents', () => {
  it('reports an account switch, once', async () => {
    const { state, events, hint } = setup();
    const seen: GnoAccount[] = [];
    events.on('accountChanged', (account) => seen.push(account));
    await flush(); // baseline

    state.account = { value: bob };
    await hint();
    await hint();

    expect(seen).toEqual([bob]);
  });

  it('says nothing when nothing changed, or only the chain the address was read on', async () => {
    const { state, events, hint } = setup();
    const listener = jest.fn();
    events.on('accountChanged', listener);
    await flush();

    state.account = { value: { ...alice, chainid: 'test5' } };
    await hint();

    expect(listener).not.toHaveBeenCalled();
  });

  it('reports a network change with the network in effect', async () => {
    const { state, events, hint } = setup();
    const seen: GnoNetwork[] = [];
    events.on('networkChanged', (network) => seen.push(network));
    await flush();

    state.network = { value: test5 };
    await hint();

    expect(seen).toEqual([test5]);
  });

  it('reports a revoked origin as disconnect, and nothing after', async () => {
    const { state, events, hint } = setup();
    const disconnect = jest.fn();
    const accountChanged = jest.fn();
    events.on('disconnect', disconnect);
    events.on('accountChanged', accountChanged);
    await flush();

    state.account = 'disconnected';
    state.network = 'disconnected';
    await hint();
    await hint();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(null);
    expect(accountChanged).not.toHaveBeenCalled();
  });

  it('tells an origin that was never approved nothing at all', async () => {
    const { state, events, hint } = setup();
    state.account = 'disconnected';
    state.network = 'disconnected';
    const listener = jest.fn();
    events.on('disconnect', listener);
    events.on('accountChanged', listener);
    events.on('networkChanged', listener);
    await flush();

    await hint();

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps what it knew when the wallet cannot answer (locked)', async () => {
    const { state, events, hint } = setup();
    const listener = jest.fn();
    events.on('accountChanged', listener);
    events.on('disconnect', listener);
    await flush();

    state.account = 'unknown';
    await hint();
    state.account = { value: alice };
    await hint();

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not re-announce what the page was just told', async () => {
    const { state, events, hint } = setup();
    const listener = jest.fn();
    events.on('accountChanged', listener);
    await flush();

    state.account = { value: bob };
    events.rememberAccount(bob); // the page's own getAccount already returned it
    await hint();

    expect(listener).not.toHaveBeenCalled();
  });

  it('reads nothing until someone subscribes', async () => {
    const { hint, reads } = setup();
    await hint();
    expect(reads()).toBe(0);
  });

  it('isolates a throwing listener and honours unsubscribe', async () => {
    const { state, events, hint } = setup();
    const kept = jest.fn();
    const dropped = jest.fn();
    events.on('accountChanged', () => {
      throw new Error('page bug');
    });
    events.on('accountChanged', kept);
    const off = events.on('accountChanged', dropped);
    await flush();
    off();

    state.account = { value: bob };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await hint();
    warn.mockRestore();

    expect(kept).toHaveBeenCalledWith(bob);
    expect(dropped).not.toHaveBeenCalled();
  });
});
