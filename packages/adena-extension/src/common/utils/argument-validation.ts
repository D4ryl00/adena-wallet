import { isBech32Address } from '@common/utils/string-utils';
import { GnoArgumentInfo } from '@inject/message/methods/gno-connect';
import { ContractMessage } from '@inject/types';

export interface ArgumentValidationResult {
  messageErrors: (string | undefined)[];
}

const INTEGER_TYPES = new Set(['int', 'int8', 'int16', 'int32', 'int64']);

const UNSIGNED_INTEGER_TYPES = new Set(['uint', 'uint8', 'uint16', 'uint32', 'uint64']);

const FLOAT_TYPES = new Set(['float32', 'float64']);

/**
 * Types a blank cannot be a value of. For a `string` it can — clearing a field
 * is a real request — but for a number, bool or address a blank means the
 * parameter was never filled in. Every MsgCall argument is a string on the wire,
 * so nothing downstream catches it before the user has paid gas.
 */
const VALUE_REQUIRED_TYPES: ReadonlySet<string> = new Set<string>([
  ...INTEGER_TYPES,
  ...UNSIGNED_INTEGER_TYPES,
  ...FLOAT_TYPES,
  'bool',
  'address',
]);

/** Blank, on a type that cannot be blank: an unfilled argument. */
export function isMissingArgument(value: string, gnoType: string | undefined): boolean {
  return value === '' && !!gnoType && VALUE_REQUIRED_TYPES.has(gnoType);
}

function isValidInteger(value: string): boolean {
  return /^-?\d+$/.test(value.trim());
}

function isValidUnsignedInteger(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function isValidFloat(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

function isValidBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === 'false';
}

function validateArgument(value: string, gnoType: string): string | undefined {
  if (INTEGER_TYPES.has(gnoType)) {
    return isValidInteger(value) ? undefined : `Expected ${gnoType}`;
  }

  if (UNSIGNED_INTEGER_TYPES.has(gnoType)) {
    return isValidUnsignedInteger(value) ? undefined : `Expected ${gnoType}`;
  }

  if (FLOAT_TYPES.has(gnoType)) {
    return isValidFloat(value) ? undefined : `Expected ${gnoType}`;
  }

  if (gnoType === 'bool') {
    return isValidBool(value) ? undefined : 'Expected true or false';
  }

  if (gnoType === 'address') {
    return isBech32Address(value.trim()) ? undefined : 'Expected a valid address';
  }

  // A string, or a type we do not check.
  return undefined;
}

/**
 * Validates transaction message arguments against their declared types.
 * Only validates /vm.m_call messages that have matching argumentInfos with type data.
 */
export function validateMessageArguments(
  messages: ContractMessage[],
  argumentInfos: GnoArgumentInfo[],
): ArgumentValidationResult {
  const messageErrors: (string | undefined)[] = new Array(messages.length).fill(undefined);

  if (argumentInfos.length === 0) {
    return { messageErrors };
  }

  const typedArgInfos = argumentInfos.filter((info) => !!info.type);
  if (typedArgInfos.length === 0) {
    return { messageErrors };
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type !== '/vm.m_call') continue;

    const args: string[] = (msg.value as { args?: string[] })?.args || [];

    for (const argInfo of typedArgInfos) {
      const argValue = args[argInfo.index];
      if (argValue === undefined || !argInfo.type) continue;

      // Apart from "invalid": one value is wrong, the other was never given.
      if (isMissingArgument(argValue, argInfo.type)) {
        messageErrors[i] = `Missing argument: "${argInfo.key}"`;
        break;
      }

      const error = validateArgument(argValue, argInfo.type);
      if (error) {
        messageErrors[i] = `Invalid argument: "${argInfo.key}"`;
        break;
      }
    }
  }

  return { messageErrors };
}
