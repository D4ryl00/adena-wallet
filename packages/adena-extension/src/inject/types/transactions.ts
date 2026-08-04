import { MsgAddPackage, MsgCall, MsgRun, MsgSend } from '@gnolang/gno-js-client';
import { BroadcastTxCommitResult } from '@gnolang/tm2-js-client';
import { GnoArgumentInfo } from '@inject/message/methods/gno-connect';

import { AdenaResponse } from '.';

export const EMessageType = {
  BANK_MSG_SEND: '/bank.MsgSend',
  VM_CALL: '/vm.m_call',
  VM_ADDPKG: '/vm.m_addpkg',
  VM_RUN: '/vm.m_run',
  VM_ENABLE_PKG: '/vm.m_enable_pkg',
  VM_REJECT_PKG: '/vm.m_reject_pkg',
  AUTH_CREATE_SESSION: '/auth.m_create_session',
  AUTH_REVOKE_SESSION: '/auth.m_revoke_session',
  AUTH_REVOKE_ALL_SESSIONS: '/auth.m_revoke_all_sessions',
} as const;

export type EMessageType = (typeof EMessageType)[keyof typeof EMessageType];

export const FUNCTION_NAME_MAP: Record<EMessageType, string> = {
  [EMessageType.BANK_MSG_SEND]: 'Transfer',
  [EMessageType.VM_ADDPKG]: 'AddPackage',
  [EMessageType.VM_RUN]: 'Run',
  [EMessageType.VM_CALL]: 'Call',
  [EMessageType.VM_ENABLE_PKG]: 'Enable Package',
  [EMessageType.VM_REJECT_PKG]: 'Reject Package',
  [EMessageType.AUTH_CREATE_SESSION]: 'Create Session',
  [EMessageType.AUTH_REVOKE_SESSION]: 'Revoke Session',
  [EMessageType.AUTH_REVOKE_ALL_SESSIONS]: 'Revoke All Sessions',
};

export type SessionAdminMessage = {
  creator?: string;
  session_key?: unknown;
  expires_at?: unknown;
  allow_paths?: string[];
  spend_limit?: string;
  spend_period?: unknown;
};

export type PackageApprovalMessage = {
  approver?: string;
  sender?: string;
  pkg_path?: string;
  pkg_hash?: string;
  pkg_height?: unknown;
};

export type TMessage =
  | MsgAddPackage
  | MsgCall
  | MsgSend
  | MsgRun
  | SessionAdminMessage
  | PackageApprovalMessage;

export type ContractMessage = {
  type: EMessageType;
  value: TMessage;
};

export type TransactionParams = {
  messages: ContractMessage[];
  memo?: string;
  networkInfo?: {
    chainId: string;
    rpcUrl: string;
  };
  /**
   * The endpoint the *page* declared, when it differs from the one the wallet
   * will actually use for this chain.
   *
   * **Display only, and untrusted.** Nothing that builds, queries or signs may
   * read this: a page choosing the node is the bug the resolution rules exist to
   * prevent. It is carried solely so the review screen can show the divergence,
   * which is the only signal available that a non-unique chain id (`dev` names
   * every devnet) selected a different network than the page meant.
   */
  declaredRpcUrl?: string;
  /**
   * The bech32 address the request pinned as its signer.
   *
   * Unlike `declaredRpcUrl` this one is enforced: the approval screen refuses to
   * sign unless the account it would sign with resolves to exactly this address.
   * Checking it only where the request is made is not enough — the check and the
   * signature happen in different worlds and at different times, and "MUST sign
   * as that identity and MUST NOT sign as another" is a property of the
   * signature, so it has to hold where the signature is produced.
   */
  signer?: string;
  arguments?: GnoArgumentInfo[] | null;
};

export interface ContractOptions {
  withNotification?: boolean;
  isVisibleResult?: boolean;
}

/**
 * Transaction fee structure
 */
export interface Fee {
  amount: {
    amount: string;
    denom: string;
  }[];
  gas: string;
}

/**
 * Base document structure shared by all document types
 */
export interface BaseDocument {
  chain_id: string;
  fee: Fee;
  msgs: unknown[];
}

// TODO: BroadcastTxCommitResult isn't correct in case of a VM call
export type DoContractResponse = AdenaResponse<BroadcastTxCommitResult>;

export type AdenaDoContract = (params: TransactionParams) => Promise<DoContractResponse>;

type SignTxResponseData = {
  encodedTransaction: string;
};

export type SignTxResponse = AdenaResponse<SignTxResponseData>;

export type AdenaSignTx = (params: TransactionParams) => Promise<SignTxResponse>;
