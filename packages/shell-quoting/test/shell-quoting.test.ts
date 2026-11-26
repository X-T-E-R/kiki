import { describe, expect, it } from 'vitest';

import { quoteCmdShellArg, quotePosixShellArg, quoteShellArg } from '#/index';

describe('quotePosixShellArg', () => {
  it('quotes empty strings as empty single quotes', () => {
    expect(quotePosixShellArg('')).toBe("''");
  });

  it.each([
    'simple',
    '/usr/bin/node',
    'key=value',
    'file.txt',
    'a%b+c,d@e:f^g-h_i',
  ])('leaves safe POSIX token %s unquoted', (value) => {
    expect(quotePosixShellArg(value)).toBe(value);
  });

  it('escapes embedded single quotes using POSIX shlex.quote form', () => {
    expect(quotePosixShellArg("it's a test")).toBe(`'it'"'"'s a test'`);
    expect(quotePosixShellArg("'")).toBe(`''"'"''`);
  });

  it.each([
    ['hello world', "'hello world'"],
    ['$HOME `id` | &', "'$HOME `id` | &'"],
    ['a;b(c){d}<e>', "'a;b(c){d}<e>'"],
    ['中文路径/文件.txt', "'中文路径/文件.txt'"],
    ['line1\nline2', "'line1\nline2'"],
  ])('single-quotes unsafe POSIX input %j', (input, expected) => {
    expect(quotePosixShellArg(input)).toBe(expected);
  });
});

describe('quoteCmdShellArg', () => {
  it('wraps values in double quotes and escapes embedded double quotes and trailing backslashes', () => {
    expect(quoteCmdShellArg('')).toBe('""');
    expect(quoteCmdShellArg('C:\\Program Files\\kiki')).toBe('"C:\\Program Files\\kiki"');
    expect(quoteCmdShellArg('C:\\Program Files\\kiki\\')).toBe('"C:\\Program Files\\kiki\\\\"');
    expect(quoteCmdShellArg('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe('quoteShellArg', () => {
  it('dispatches by explicit platform', () => {
    expect(quoteShellArg('hello world', 'linux')).toBe("'hello world'");
    expect(quoteShellArg('hello world', 'darwin')).toBe("'hello world'");
    expect(quoteShellArg('hello world', 'win32')).toBe('"hello world"');
    expect(quoteShellArg('safe/path', 'linux')).toBe('safe/path');
    expect(quoteShellArg('safe/path', 'win32')).toBe('"safe/path"');
  });
});
