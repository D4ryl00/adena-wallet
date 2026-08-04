import { GnoArgumentInfo } from '@inject/message/methods/gno-connect';
import { ContractMessage } from '@inject/types';

import { isMissingArgument, validateMessageArguments } from './argument-validation';

function call(args: string[]): ContractMessage {
  return {
    type: '/vm.m_call',
    value: {
      caller: '',
      send: '',
      pkg_path: 'gno.land/r/demo/boards',
      func: 'CreateThread',
      args,
      max_deposit: '',
    },
  } as unknown as ContractMessage;
}

function arg(index: number, key: string, type: string): GnoArgumentInfo {
  return { index, key, value: '', type };
}

describe('isMissingArgument', () => {
  it('treats a blank as missing for a type that cannot be blank', () => {
    expect(isMissingArgument('', 'int')).toBe(true);
    expect(isMissingArgument('', 'uint64')).toBe(true);
    expect(isMissingArgument('', 'float64')).toBe(true);
    expect(isMissingArgument('', 'bool')).toBe(true);
    expect(isMissingArgument('', 'address')).toBe(true);
  });

  // Clearing a field is a real request, and "" is what it looks like.
  it('treats a blank string as a value, not an omission', () => {
    expect(isMissingArgument('', 'string')).toBe(false);
  });

  // We do not check these types at all, so we know too little to call a blank
  // wrong.
  it('leaves a blank alone on a type it does not check', () => {
    expect(isMissingArgument('', '[]byte')).toBe(false);
    expect(isMissingArgument('', 'MyStruct')).toBe(false);
    expect(isMissingArgument('', undefined)).toBe(false);
  });

  it('is not concerned with values that are present', () => {
    expect(isMissingArgument('0', 'int')).toBe(false);
    expect(isMissingArgument('nonsense', 'int')).toBe(false);
  });
});

describe('validateMessageArguments', () => {
  // The case this exists for. A named call may prefill only some arguments, and
  // the rest arrive as ''. They used to pass silently: every MsgCall argument is
  // a string on the wire, so nothing downstream caught it and the user paid gas
  // to be told by the chain.
  it('flags an argument that was never filled in', () => {
    const result = validateMessageArguments(
      [call(['', 'a title'])],
      [arg(0, 'bid', 'int'), arg(1, 'title', 'string')],
    );

    expect(result.messageErrors[0]).toBe('Missing argument: "bid"');
  });

  it('accepts a blank string argument', () => {
    const result = validateMessageArguments([call([''])], [arg(0, 'body', 'string')]);

    expect(result.messageErrors[0]).toBeUndefined();
  });

  // Two different problems, so two different messages: one value is wrong, the
  // other was never given, and the user does something different about each.
  it('distinguishes a missing argument from a malformed one', () => {
    const missing = validateMessageArguments([call([''])], [arg(0, 'bid', 'int')]);
    const malformed = validateMessageArguments([call(['abc'])], [arg(0, 'bid', 'int')]);

    expect(missing.messageErrors[0]).toBe('Missing argument: "bid"');
    expect(malformed.messageErrors[0]).toBe('Invalid argument: "bid"');
  });

  it('accepts a complete, well-formed call', () => {
    const result = validateMessageArguments(
      [call(['2', 'true', 'g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5'])],
      [arg(0, 'bid', 'int'), arg(1, 'listed', 'bool'), arg(2, 'owner', 'address')],
    );

    expect(result.messageErrors[0]).toBeUndefined();
  });

  // Positional arguments carry no type — the producer asserted the order and
  // owns it — so there is nothing here to check against.
  it('says nothing about arguments with no declared type', () => {
    const result = validateMessageArguments(
      [call(['', ''])],
      [
        { index: 0, key: '0', value: '' },
        { index: 1, key: '1', value: '' },
      ],
    );

    expect(result.messageErrors[0]).toBeUndefined();
  });

  it('reports each message separately', () => {
    const result = validateMessageArguments(
      [call(['1']), call([''])],
      [arg(0, 'bid', 'int')],
    );

    expect(result.messageErrors).toEqual([undefined, 'Missing argument: "bid"']);
  });
});
