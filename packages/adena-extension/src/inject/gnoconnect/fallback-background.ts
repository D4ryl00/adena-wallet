import { ExecutorTransport } from '@inject/executor/executor';

import { sendTxFrom, transportHost } from './provider';
import { FallbackReply, FallbackSendTx, GNO_FALLBACK_SEND_TX, GnoErrorCode } from './types';

export function isFallbackSendTx(message: unknown): message is FallbackSendTx {
  const { type, intent, siteName } = (message ?? {}) as Partial<FallbackSendTx>;
  return (
    type === GNO_FALLBACK_SEND_TX &&
    typeof siteName === 'string' &&
    typeof intent?.path === 'string' &&
    typeof intent?.func === 'string' &&
    Array.isArray(intent?.args)
  );
}

/** Runs `sendTx` for the page through `dispatch`, which carries the sender's real origin. */
export async function answerFallbackSendTx(
  message: FallbackSendTx,
  dispatch: ExecutorTransport,
): Promise<FallbackReply> {
  const host = transportHost(dispatch, message.siteName, message.intent.chainid ?? '');
  try {
    return { response: await sendTxFrom(host, message.intent) };
  } catch (error) {
    const { code, message: text } = (error ?? {}) as { code?: GnoErrorCode; message?: string };
    return { error: { code, message: text ?? String(error) } };
  }
}
