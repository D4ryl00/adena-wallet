// The provider pulls in the SDK, whose native crypto fails under jsdom.
const mockSendTxFrom = jest.fn();
const mockTransportHost = jest.fn((...args: unknown[]) => ({ args }));
jest.mock('./provider', () => ({
  sendTxFrom: (...args: unknown[]): unknown => mockSendTxFrom(...args),
  transportHost: (...args: unknown[]): unknown => mockTransportHost(...args),
}));

import { answerFallbackSendTx, isFallbackSendTx } from './fallback-background';
import { FallbackSendTx, GNO_FALLBACK_SEND_TX } from './types';

const request: FallbackSendTx = {
  type: GNO_FALLBACK_SEND_TX,
  intent: { path: 'gno.land/r/demo/foo', func: 'Bar', args: [], chainid: 'dev' },
  siteName: 'foo',
};

describe('isFallbackSendTx', () => {
  it('accepts the fallback request and nothing else', () => {
    expect(isFallbackSendTx(request)).toBe(true);
    expect(isFallbackSendTx({ ...request, type: 'other' })).toBe(false);
    expect(isFallbackSendTx({ ...request, intent: { path: 'x' } })).toBe(false);
    expect(isFallbackSendTx(null)).toBe(false);
  });
});

describe('answerFallbackSendTx', () => {
  const dispatch = jest.fn();

  it('runs sendTx through the transport, on the chain the page declared', async () => {
    mockSendTxFrom.mockResolvedValueOnce({ status: 'Approved', args: { hash: 'h' } });
    const reply = await answerFallbackSendTx(request, dispatch);
    expect(mockTransportHost).toHaveBeenCalledWith(dispatch, 'foo', 'dev');
    expect(reply).toEqual({ response: { status: 'Approved', args: { hash: 'h' } } });
  });

  it('carries a failure back with its code, for the content script to decide', async () => {
    mockSendTxFrom.mockRejectedValueOnce(
      Object.assign(new Error('bad'), { code: 'invalid_request' }),
    );
    expect(await answerFallbackSendTx(request, dispatch)).toEqual({
      error: { code: 'invalid_request', message: 'bad' },
    });
  });
});
