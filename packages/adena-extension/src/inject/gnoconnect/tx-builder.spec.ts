import { GnoDocumentInfo } from '@common/provider/gno';

import {
  buildTransactionParams,
  RealmDocumentError,
  resolveArguments,
  toContractMessage,
} from './tx-builder';
import { GnoTransactionIntent } from './types';

function realmDocument(
  params: { name: string; type: string }[],
  funcName = 'CreateThread',
): GnoDocumentInfo {
  return {
    package_path: 'gno.land/r/demo/boards',
    funcs: [{ name: funcName, params, results: [] }],
  } as unknown as GnoDocumentInfo;
}

function intent(overrides: Partial<GnoTransactionIntent> = {}): GnoTransactionIntent {
  return {
    path: 'gno.land/r/demo/boards',
    func: 'CreateThread',
    args: [],
    ...overrides,
  };
}

describe('resolveArguments', () => {
  // The standard names arguments; a /vm.m_call takes them positionally. The
  // realm's declaration order is the only authority on which is which.
  it('orders named arguments by the realm declaration, not by call order', () => {
    const resolved = resolveArguments(
      intent({
        args: [
          { name: 'body', value: 'the body' },
          { name: 'bid', value: '2' },
          { name: 'title', value: 'the title' },
        ],
      }),
      realmDocument([
        { name: 'bid', type: 'uint64' },
        { name: 'title', type: 'string' },
        { name: 'body', type: 'string' },
      ]),
    );

    expect(resolved.map((arg) => arg.key)).toEqual(['bid', 'title', 'body']);
    expect(resolved.map((arg) => arg.value)).toEqual(['2', 'the title', 'the body']);
  });

  it('carries the declared type through for the approval screen to validate', () => {
    const resolved = resolveArguments(
      intent({ args: [{ name: 'bid', value: '2' }] }),
      realmDocument([{ name: 'bid', type: 'uint64' }]),
    );

    expect(resolved[0]).toEqual({ index: 0, key: 'bid', value: '2', type: 'uint64' });
  });

  // A link may prefill only some arguments; the rest are the user's to complete.
  it('leaves unprefilled arguments empty rather than dropping them', () => {
    const resolved = resolveArguments(
      intent({ args: [{ name: 'title', value: 'the title' }] }),
      realmDocument([
        { name: 'title', type: 'string' },
        { name: 'body', type: 'string' },
      ]),
    );

    expect(resolved).toHaveLength(2);
    expect(resolved[1]).toEqual({ index: 1, key: 'body', value: '', type: 'string' });
  });

  // `cur realm` is supplied by the VM, not the caller, so it must not consume a
  // positional slot.
  it('filters out inter-realm parameters', () => {
    const resolved = resolveArguments(
      intent({ args: [{ name: 'bid', value: '2' }] }),
      realmDocument([
        { name: 'cur', type: 'realm' },
        { name: 'bid', type: 'uint64' },
      ]),
    );

    expect(resolved.map((arg) => arg.key)).toEqual(['bid']);
    expect(resolved[0].index).toBe(0);
  });

  // Dropping it quietly, or binding it positionally, both mean signing
  // something other than what was asked with nothing on screen to say so.
  it('rejects an argument the realm does not declare', () => {
    expect(() =>
      resolveArguments(
        intent({
          args: [
            { name: 'bid', value: '2' },
            { name: 'notAParameter', value: 'x' },
          ],
        }),
        realmDocument([{ name: 'bid', type: 'uint64' }]),
      ),
    ).toThrow(/no such parameter: notAParameter/);
  });

  it('throws when the realm has no such function', () => {
    expect(() =>
      resolveArguments(intent({ func: 'NoSuchFunc' }), realmDocument([{ name: 'bid', type: 'uint64' }])),
    ).toThrow(RealmDocumentError);
  });
});

describe('toContractMessage', () => {
  it('builds a /vm.m_call with positional args in resolved order', () => {
    const resolved = resolveArguments(
      intent({
        args: [
          { name: 'title', value: 'the title' },
          { name: 'bid', value: '2' },
        ],
      }),
      realmDocument([
        { name: 'bid', type: 'uint64' },
        { name: 'title', type: 'string' },
      ]),
    );

    expect(toContractMessage(intent({ send: '100ugnot' }), resolved)).toEqual({
      type: '/vm.m_call',
      value: {
        caller: '',
        send: '100ugnot',
        pkg_path: 'gno.land/r/demo/boards',
        func: 'CreateThread',
        args: ['2', 'the title'],
        max_deposit: '',
      },
    });
  });

  it('defaults send to empty when the intent attaches no coins', () => {
    const message = toContractMessage(intent(), []);

    expect(message.value).toMatchObject({ send: '', args: [] });
  });
});

// The positional form is the one that needs no `vm/qdoc`, which is what makes
// signing without network access reachable at all.
describe('buildTransactionParams, argument forms', () => {
  const network = { chainId: 'dev', rpcUrl: 'http://127.0.0.1:26657' };

  it('binds positional arguments in order, without a realm lookup', async () => {
    const params = await buildTransactionParams(
      [intent({ args: [{ value: '2' }, { value: 'the title' }] })],
      network,
    );

    expect((params.messages[0].value as { args: string[] }).args).toEqual(['2', 'the title']);
    // No GnoProvider was constructed: a positional call reaches no node.
    expect(params.networkInfo).toEqual(network);
  });

  // A named argument among positional ones has a position knowable only through
  // the lookup the positional form exists to avoid.
  it('rejects a call mixing named and positional arguments', async () => {
    await expect(
      buildTransactionParams(
        [intent({ args: [{ value: '2' }, { name: 'title', value: 'x' }] })],
        network,
      ),
    ).rejects.toThrow(/cannot be mixed/);
  });

  it('rejects an empty intent list', async () => {
    await expect(buildTransactionParams([], network)).rejects.toThrow(
      /No transaction intent/,
    );
  });

  // The network is the wallet's own, never one the page named — a page that
  // could choose the node would choose the qdoc document deciding arg order.
  it('carries the resolved network through, not anything from the intent', async () => {
    const params = await buildTransactionParams(
      [intent({ args: [{ value: '2' }], rpc: 'https://evil.example', chainid: 'dev' })],
      network,
    );

    expect(params.networkInfo).toEqual(network);
  });
});

// A chain id is not globally unique — `dev` names every devnet — so a declared
// endpoint the wallet is not using is the only signal that `chainid` may have
// selected a different network than the page meant. Carried for display, never
// used to build or resolve anything.
describe('buildTransactionParams, declared endpoint', () => {
  const network = { chainId: 'dev', rpcUrl: 'http://127.0.0.1:26657' };

  it('surfaces a declared endpoint that differs from the one in use', async () => {
    const params = await buildTransactionParams(
      [intent({ args: [{ value: '2' }] })],
      network,
      'http://127.0.0.1:36657',
    );

    expect(params.declaredRpcUrl).toBe('http://127.0.0.1:36657');
    // The network actually used is untouched by it.
    expect(params.networkInfo).toEqual(network);
  });

  it('says nothing when the declaration agrees', async () => {
    const params = await buildTransactionParams(
      [intent({ args: [{ value: '2' }] })],
      network,
      network.rpcUrl,
    );

    expect(params.declaredRpcUrl).toBeUndefined();
  });

  it('says nothing when the page declared no endpoint', async () => {
    const params = await buildTransactionParams([intent({ args: [{ value: '2' }] })], network);

    expect(params.declaredRpcUrl).toBeUndefined();
  });
});
