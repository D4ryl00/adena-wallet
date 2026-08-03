import { DEFAULT_GAS_WANTED } from '@common/constants/tx.constant';
import { GnoDocumentInfo } from '@common/provider/gno';
import { GnoProvider } from '@common/provider/gno/gno-provider';
import { isInterRealmParameter } from '@common/provider/gno/utils';
import { GnoArgumentInfo } from '@inject/message/methods/gno-connect';
import { ContractMessage, TransactionParams } from '@inject/types';

import { GnoConnectRequestError } from './errors';
import { GnoTransactionIntent, isNamedArgument } from './types';

export class RealmDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealmDocumentError';
  }
}

/** The network the wallet will actually sign and broadcast through. */
export interface ResolvedNetwork {
  chainId: string;
  rpcUrl: string;
}

/**
 * A call is named or positional, never both.
 *
 * Mixing has no coherent meaning: a named argument among positional ones has a
 * position knowable only through `vm/qdoc`, at which point the call needs the
 * network anyway and the positional form has bought nothing.
 */
function argumentForm(intent: GnoTransactionIntent): 'named' | 'positional' {
  const args = intent.args ?? [];
  if (args.length === 0) {
    return 'named';
  }

  const named = args.filter(isNamedArgument).length;
  if (named !== 0 && named !== args.length) {
    throw new GnoConnectRequestError(
      'invalid_request',
      `${intent.path}.${intent.func}: named and positional arguments cannot be mixed`,
    );
  }

  return named === args.length ? 'named' : 'positional';
}

/**
 * Binds positional arguments straight through, in the order the producer gave.
 *
 * No `vm/qdoc` lookup, which is what makes this form work without network
 * access. A wallet may still look the document up to label the review screen,
 * but it must never reorder on the strength of it, and a failed lookup must not
 * block signing — so labelling happens elsewhere, not here.
 */
function bindPositional(intent: GnoTransactionIntent): GnoArgumentInfo[] {
  return (intent.args ?? []).map((arg, index) => ({
    index,
    key: `${index}`,
    value: arg.value,
  }));
}

/**
 * Maps named arguments onto the realm's declared parameter order.
 *
 * Inter-realm parameters (`cur realm`) are supplied by the VM, not the caller,
 * so they take no positional slot. An argument naming no declared parameter is
 * `invalid_request`: binding it positionally or dropping it quietly both mean
 * signing something other than what was asked, with nothing on screen to say so.
 */
export function resolveArguments(
  intent: GnoTransactionIntent,
  realmDocument: GnoDocumentInfo,
): GnoArgumentInfo[] {
  const func = realmDocument.funcs.find((f) => f.name === intent.func);
  if (!func) {
    throw new RealmDocumentError(`Function not found in ${intent.path}: ${intent.func}`);
  }

  const params = func.params.filter(
    (param) => !isInterRealmParameter(param.name, param.type),
  );

  const declared = new Set(params.map((param) => param.name));
  const unknown = (intent.args ?? [])
    .filter(isNamedArgument)
    .map((arg) => arg.name)
    .filter((name) => !declared.has(name));

  if (unknown.length > 0) {
    throw new GnoConnectRequestError(
      'invalid_request',
      `${intent.path}.${intent.func}: no such parameter: ${unknown.join(', ')}`,
    );
  }

  return params.map((param, index) => {
    const arg = (intent.args ?? [])
      .filter(isNamedArgument)
      .find((candidate) => candidate.name === param.name);
    return {
      index,
      key: param.name,
      value: arg?.value ?? '',
      type: param.type,
    };
  });
}

/** Builds the `/vm.m_call` message for a single intent, given resolved arguments. */
export function toContractMessage(
  intent: GnoTransactionIntent,
  resolvedArguments: GnoArgumentInfo[],
): ContractMessage {
  return {
    type: '/vm.m_call',
    value: {
      caller: '',
      send: intent.send ?? '',
      pkg_path: intent.path,
      func: intent.func,
      args: resolvedArguments.map((arg) => arg.value),
      max_deposit: '',
    },
  };
}

/**
 * Assembles the `TransactionParams` Adena's existing `DoContract` / `SignTx`
 * handlers consume.
 *
 * `network` is the wallet's own resolved network — never an endpoint the page
 * named. The standard makes a request's `rpc` advisory: `chainid` selects among
 * the networks the user configured, and every query and the broadcast go
 * through that network's endpoint. A page that could choose the node would be
 * choosing the `vm/qdoc` document that decides argument order, and the labels
 * the review screen shows for it.
 */
export async function buildTransactionParams(
  intents: GnoTransactionIntent[],
  network: ResolvedNetwork,
): Promise<TransactionParams & { gasFee: number; gasWanted: number }> {
  if (intents.length === 0) {
    throw new GnoConnectRequestError('invalid_request', 'No transaction intent supplied');
  }

  const messages: ContractMessage[] = [];
  const allArguments: GnoArgumentInfo[] = [];

  for (const intent of intents) {
    const form = argumentForm(intent);

    let resolvedArguments: GnoArgumentInfo[];
    if (form === 'positional') {
      resolvedArguments = bindPositional(intent);
    } else {
      const provider = new GnoProvider(network.rpcUrl, network.chainId);
      const realmDocument = await provider.getRealmDocument(intent.path);
      if (!realmDocument) {
        // Named arguments cannot be ordered without the realm's signature, and
        // falling back to the order they arrived in would bind values to an
        // order the producer never asserted. Fail instead.
        throw new RealmDocumentError(
          `Cannot resolve argument order: realm document not found for ${intent.path}`,
        );
      }
      resolvedArguments = resolveArguments(intent, realmDocument);
    }

    messages.push(toContractMessage(intent, resolvedArguments));
    allArguments.push(...resolvedArguments);
  }

  return {
    messages,
    gasFee: 0,
    gasWanted: DEFAULT_GAS_WANTED,
    networkInfo: {
      chainId: network.chainId,
      rpcUrl: network.rpcUrl,
    },
    // Single-message calls carry named arguments for the approval screen to
    // display and type-check. Multi-message calls do not: the screen renders a
    // flat list with no message index, so N sets would be ambiguous.
    arguments: messages.length === 1 ? allArguments : null,
  };
}
