import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveKikiHome } from '../src/home';

describe('Kiki product home', () => {
  it('uses the unique product home and does not reinterpret explicit empty or zero values', () => {
    expect(resolveKikiHome(undefined, {}, '/example')).toBe(resolve('/example/.kiki'));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '/new', KIMI_CODE_HOME: '/old' }, '/example')).toBe(resolve('/new'));
    expect(resolveKikiHome('/explicit', { KIKI_HOME: '/new' })).toBe(resolve('/explicit'));
    expect(resolveKikiHome(undefined, { KIMI_CODE_HOME: '/legacy' }, '/example')).toBe(resolve('/example/.kiki'));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '', KIMI_CODE_HOME: '/legacy' })).toBe(resolve(''));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '0' })).toBe(resolve('0'));
  });
});
