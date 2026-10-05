// Chrome and the wallet behind `answerSessionMessage`: storage, chain, review window.
import { isSessionAccount } from 'adena-module';

import { GnoProvider } from '@common/provider/gno/gno-provider';
import { GNOCONNECT_SESSION_SENT, GnoSessionAnswer } from '@inject/gnoconnect/types';
import { RoutePath } from '@types';

import { InjectionMessage } from '../message';
import { createPopup } from './common';
import { InjectCore } from './core';
import {
  answerSessionMessage,
  ClosedAfterSend,
  createReplayMemory,
  ReplayEntries,
  SessionDeps,
  SessionMessageData,
  SessionReviewRequest,
  toSessionReply,
} from './gno-connect-session';

// In the extension's storage, not the worker's memory: Chrome stops an idle
// worker, and a request replayed after that must still be refused.
const REPLAY_KEY = 'GNOCONNECT_SESSION_REPLAY';
const memory = createReplayMemory({
  load: async () => ((await chrome.storage.local.get(REPLAY_KEY))[REPLAY_KEY] as ReplayEntries) ?? {},
  save: (entries) => chrome.storage.local.set({ [REPLAY_KEY]: entries }),
});

/** The requesting page as the browser saw it, port included. */
function pageUrl(message: InjectionMessage, sender: chrome.runtime.MessageSender): URL {
  try {
    if (sender.url) return new URL(sender.url);
  } catch {
    // fall through
  }
  return new URL(`${message.protocol}//${message.hostname}`);
}

export function sessionDeps(
  core: InjectCore,
  message: InjectionMessage,
  sender: chrome.runtime.MessageSender,
): SessionDeps {
  const url = pageUrl(message, sender);
  // How establishments are keyed (getSiteName): protocol and hostname, no port.
  const siteName = `${url.protocol}//${url.hostname}`;

  const network = async (): Promise<{ chainId: string; rpcUrl: string; addressPrefix: string } | null> => {
    const current = await core.getCurrentNetwork();
    return current ? { chainId: current.chainId, rpcUrl: current.rpcUrl, addressPrefix: current.addressPrefix } : null;
  };
  const provider = async (): Promise<GnoProvider> => {
    const current = await network();
    if (!current) throw new Error('No active network');
    return new GnoProvider(current.rpcUrl, current.chainId);
  };
  const clock = (): number => Math.floor(Date.now() / 1000);

  return {
    origin: url.origin,
    isEstablished: async () => core.establishService.isEstablishedBy(await core.getCurrentAccountId(), siteName),
    withdrawApproval: async (): Promise<void> =>
      core.establishService.unEstablishBy(await core.getCurrentAccountId(), siteName),
    network,
    identity: async (): ReturnType<SessionDeps['identity']> => {
      const inMemoryKey = await core.getInMemoryKey();
      if (await core.isLockedBy(inMemoryKey)) return 'locked';
      const account = await core.getCurrentAccount(inMemoryKey);
      const current = await network();
      if (!account || !current) return null;
      const address = await account.getAddress(current.addressPrefix);
      const info = await core.accountService
        .getAccountInfoByNetwork(address, current.rpcUrl, current.chainId)
        .catch(() => null);
      return { address, pubkey: info?.publicKey?.value ?? null, isSession: isSessionAccount(account) };
    },
    getSession: async (master, session): ReturnType<SessionDeps['getSession']> => {
      const s = await (await provider()).getSession(master, session);
      if (!s) return null;
      return {
        expiresAt: s.expires_at ?? 0,
        allow: s.allow_paths ?? [],
        spend: s.spend_limit ?? '',
        period: s.spend_period ?? 0,
      };
    },
    countSessions: async (master) => (await (await provider()).getSessions(master)).length,
    chainNow: async (): Promise<number | null> => {
      try {
        const status = await (await provider()).getStatus();
        const block = Math.floor(Date.parse(status.sync_info.latest_block_time) / 1000);
        return Number.isFinite(block) && block > 0 ? Math.min(block, clock()) : null;
      } catch {
        return null;
      }
    },
    clock,
    review: (request: SessionReviewRequest) =>
      new Promise<GnoSessionAnswer | ClosedAfterSend>((resolve) => {
        // Once the window says it is sending, closing it is no longer a refusal.
        let sent = false;
        const onSent = (m: { type?: string; review?: string }, from: chrome.runtime.MessageSender): void => {
          if (from.id === chrome.runtime.id && m?.type === GNOCONNECT_SESSION_SENT && m.review === message.key) {
            sent = true;
          }
        };
        chrome.runtime.onMessage.addListener(onSent);
        // Closed by the user, by the extension, or never opened: no answer inside.
        const closed = { key: message.key, status: 'success', type: 'GNOCONNECT_SESSION_CLOSED' } as unknown as InjectionMessage;
        createPopup(
          RoutePath.ApproveGnoConnectSession,
          { ...message, hostname: url.hostname, protocol: url.protocol, data: request as unknown as Record<string, unknown> },
          closed,
          (reply: InjectionMessage) => {
            chrome.runtime.onMessage.removeListener(onSent);
            const answer = reply?.data?.gnoconnect as GnoSessionAnswer | undefined;
            if (answer && ('status' in answer || 'fail' in answer)) resolve(answer);
            else resolve(sent ? { closedAfterSend: true } : { status: 'Rejected' });
          },
        );
      }),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const gnoConnectSession = async (
  core: InjectCore,
  message: InjectionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (message: unknown) => void,
): Promise<void> => {
  const answer = await answerSessionMessage(
    sessionDeps(core, message, sender),
    memory,
    String(message.type),
    message.data as SessionMessageData,
  );
  sendResponse({ ...toSessionReply(answer), key: message.key });
};
