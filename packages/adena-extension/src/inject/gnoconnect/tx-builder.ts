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
 * A call is named or positional, never both — or supplies nothing, which is
 * neither.
 *
 * Mixing has no coherent meaning: a named argument among positional ones has a
 * position knowable only through `vm/qdoc`, at which point the call needs the
 * network anyway and the positional form has bought nothing.
 */
function argumentForm(intent: GnoMessageIntent): 'named' | 'positional' | 'none' {
  const args = intent.args ?? [];
  if (args.length === 0) {
    // Neither form. The forms answer "in what order do these values go", and
    // with no values there is no order to settle — so the lookup below is for
    // labelling only, and its failure must not block signing.
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
 * Binds positional arguments straight through, in the order the producer gave.
 *
 * No `vm/qdoc` lookup, which is what makes this form work without network
 * access. A wallet may still look the document up to label the review screen,
 * but it must never reorder on the strength of it, and a failed lookup must not
 * block signing — so labelling happens elsewhere, not here.
 */
function bindPositional(intent: GnoMessageIntent): GnoArgumentInfo[] {
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
  intents: GnoMessageIntent[],
  network: ResolvedNetwork,
  /**
   * The endpoint the page declared, for the review screen only. Deliberately a
   * separate parameter from `network`: it must be impossible to reach it from
   * anywhere in this function that builds or resolves anything.
   */
  declaredRpcUrl?: string,
  /**
   * The `signer` pin, carried through so the approval screen can enforce it
   * against the account it is about to sign with. The provider checks it too,
   * but that check happens in the page world before the popup exists.
   */
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
      // Supplying nothing is not an error, and it must not need the network.
      // A function declaring no parameters — `Increment()` and its kind — is the
      // one call shape that needs no lookup at all, and requiring one would put
      // it behind a round trip and out of reach of offline signing.
      //
      // The lookup is still worth attempting: with the document the review
      // screen can name the parameters the user has left to fill. Without it,
      // the screen shows a call that supplies no arguments, which is the honest
      // thing to show and enough for the user to judge.
      const provider = new GnoProvider(network.rpcUrl, network.chainId);
      const realmDocument = await provider.getRealmDocument(intent.path).catch(() => null);
      resolvedArguments = realmDocument ? resolveArguments(intent, realmDocument) : [];
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
    // Only when it disagrees with what we will actually use — an agreeing
    // declaration is not worth a row on the review screen.
    ...(declaredRpcUrl && declaredRpcUrl !== network.rpcUrl
      ? { declaredRpcUrl }
      : {}),
    ...(signer ? { signer } : {}),
    // Single-message calls carry named arguments for the approval screen to
    // display and type-check. Multi-message calls do not: the screen renders a
    // flat list with no message index, so N sets would be ambiguous.
    arguments: messages.length === 1 ? allArguments : null,
  };
}
