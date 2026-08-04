import { DEFAULT_GAS_WANTED } from '@common/constants/tx.constant';
import { GnoDocumentInfo } from '@common/provider/gno';
import { GnoProvider } from '@common/provider/gno/gno-provider';
import { isInterRealmParameter } from '@common/provider/gno/utils';
import { GnoArgumentInfo } from '@inject/message/methods/gno-connect';
import { ContractMessage, TransactionParams } from '@inject/types';

import { GnoConnectRequestError } from './errors';
import { GnoMessageIntent, isNamedArgument } from './types';

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
 * Named or positional, never both — or nothing, which is neither. Mixing has no
 * meaning: a named argument among positional ones has a position knowable only
 * through the lookup the positional form exists to avoid.
 */
function argumentForm(intent: GnoMessageIntent): 'named' | 'positional' | 'none' {
  const args = intent.args ?? [];
  if (args.length === 0) {
    // No values, so no order to settle: the lookup is for labelling only.
    return 'none';
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
 * Straight through, in the order the producer gave. No `vm/qdoc` lookup, which
 * is what makes this form work without network access.
 */
function bindPositional(intent: GnoMessageIntent): GnoArgumentInfo[] {
  return (intent.args ?? []).map((arg, index) => ({
    index,
    key: `${index}`,
    value: arg.value,
  }));
}

/**
 * Maps named arguments onto the realm's declared order. Inter-realm parameters
 * (`cur realm`) come from the VM and take no slot. An argument naming no
 * declared parameter is `invalid_request` — dropping it quietly would sign
 * something other than what was asked.
 */
export function resolveArguments(
  intent: GnoMessageIntent,
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
  intent: GnoMessageIntent,
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
 * Assembles the `TransactionParams` `DoContract`/`SignTx` consume. `network` is
 * the wallet's own resolved network, never one the page named: choosing the node
 * would choose the `vm/qdoc` document that decides argument order.
 */
export async function buildTransactionParams(
  intents: GnoMessageIntent[],
  network: ResolvedNetwork,
  /** Review screen only. A separate parameter so nothing here can reach it. */
  declaredRpcUrl?: string,
  /** Carried through so the approval screen can enforce it where it signs. */
  signer?: string,
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
    } else if (form === 'none') {
      // A parameterless function needs no lookup at all, so requiring one would
      // put `Increment()` and its kind out of reach of offline signing. Still
      // worth attempting: the document names the parameters left to fill.
      const provider = new GnoProvider(network.rpcUrl, network.chainId);
      const realmDocument = await provider.getRealmDocument(intent.path).catch(() => null);
      resolvedArguments = realmDocument ? resolveArguments(intent, realmDocument) : [];
    } else {
      const provider = new GnoProvider(network.rpcUrl, network.chainId);
      const realmDocument = await provider.getRealmDocument(intent.path);
      if (!realmDocument) {
        // Falling back to arrival order would bind values to an order the
        // producer never asserted.
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
    // Only when it disagrees with the endpoint we will use.
    ...(declaredRpcUrl && declaredRpcUrl !== network.rpcUrl
      ? { declaredRpcUrl }
      : {}),
    ...(signer ? { signer } : {}),
    // Single-message only: the screen renders a flat list with no message
    // index, so N sets would be ambiguous.
    arguments: messages.length === 1 ? allArguments : null,
  };
}
