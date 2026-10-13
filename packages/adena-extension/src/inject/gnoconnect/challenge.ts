// `connect` with a `challenge`: the identity signs the producer's text through
// SignArbitrary. Free of @adena-wallet/sdk so jest can load it; the provider
// supplies the steps.
import { fromBase64 } from '@cosmjs/encoding';
import { toBech32 } from 'adena-module';

import { GnoConnectRequestError } from './errors';
import { GnoAccount, GnoConnectOptions, GnoErrorCode, UserResponse } from './types';

export const MAX_CHALLENGE_BYTES = 4096;

/** C0, DEL and C1, as Go's unicode.IsControl. */
const isControl = (c: number): boolean => c <= 0x1f || (c >= 0x7f && c <= 0x9f);

/** A surrogate with no partner: not text, and UTF-8 would sign U+FFFD in its place. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The standard's rules for a challenge; returns the text. */
export function validateChallenge(opts: GnoConnectOptions): string {
  const { challenge } = opts;
  const bad = (why: string): never => {
    throw new GnoConnectRequestError('invalid_request', `challenge: ${why}`);
  };
  if (opts.pubkey !== undefined) bad('a connect proves an identity or names a key, not both');
  if (typeof challenge !== 'string' || challenge === '') return bad('empty');
  if (new TextEncoder().encode(challenge).length > MAX_CHALLENGE_BYTES) bad(`over ${MAX_CHALLENGE_BYTES} bytes`);
  if ([...challenge].some((c) => isControl(c.codePointAt(0) ?? 0))) bad('a control character');
  if (LONE_SURROGATE.test(challenge)) bad('not well-formed text (a lone surrogate)');
  return challenge;
}

/** The amino Any of a secp256k1 key, as tm2 prints it: `0a13 "/tm.PubKeySecp256k1" 1223 0a21` + key. */
const SECP_PREFIX = [0x0a, 0x13, ...Array.from('/tm.PubKeySecp256k1', (c) => c.charCodeAt(0)), 0x12, 0x23, 0x0a, 0x21];

export function gpubFromCompressed(base64: string): string {
  const key = fromBase64(base64);
  if (key.length !== 33) {
    throw new GnoConnectRequestError('signer_unavailable', `the account's key is ${key.length} bytes, not a secp256k1 key`);
  }
  // A gpub is longer than bech32's default 90 characters.
  return toBech32('gpub', Uint8Array.from([...SECP_PREFIX, ...key]), Infinity);
}

/** SignArbitrary's answer, as far as the proof needs it. */
export interface SignedText {
  signed: { chain_id: string } & Record<string, unknown>;
  signature?: { pubKey?: { value?: string }; signature?: string };
}

/** What the flow needs from the wallet; a GnoConnectRequestError thrown is an answer. */
export interface ChallengeSteps {
  establish(): Promise<UserResponse<null>>;
  /** The chain to sign for: `chainid`, switched to if needed, or the active one. */
  resolveNetwork(chainid?: string): Promise<string>;
  currentAddress(): Promise<string>;
  sign(signer: string, data: string): Promise<UserResponse<SignedText>>;
}

const refused = (code?: GnoErrorCode): UserResponse<never> =>
  code ? { status: 'Rejected', code } : { status: 'Rejected' };

export async function connectWithChallenge(
  steps: ChallengeSteps,
  opts: GnoConnectOptions,
  features: string[],
): Promise<UserResponse<GnoAccount>> {
  try {
    const challenge = validateChallenge(opts);
    if (opts.signer !== undefined && typeof opts.signer !== 'string') {
      throw new GnoConnectRequestError('invalid_request', 'signer: not an address');
    }
    const established = await steps.establish();
    if (established.status === 'Rejected') return established;
    await steps.resolveNetwork(opts.chainid);
    const signer = await steps.currentAddress();
    if (opts.signer && opts.signer.toLowerCase() !== signer.toLowerCase()) {
      throw new GnoConnectRequestError('signer_unavailable', `Cannot sign as ${opts.signer}: it is not the active account`);
    }
    const answer = await steps.sign(signer, challenge);
    if (answer.status === 'Rejected') return answer;
    const { signed, signature } = answer.args;
    if (!signature?.pubKey?.value || !signature.signature) {
      throw new GnoConnectRequestError('signer_unavailable', 'The wallet answered without a key or signature');
    }
    return {
      status: 'Approved',
      args: {
        address: signer,
        chainid: signed.chain_id,
        pubkey: gpubFromCompressed(signature.pubKey.value),
        features,
        proof: { signed, signature: signature.signature },
      },
    };
  } catch (error) {
    // No account at all is a genuine failure, which rejects the promise (the standard's Answers); the rest are answers.
    if (error instanceof GnoConnectRequestError && error.code !== 'no_signer') return refused(error.code);
    throw error;
  }
}
