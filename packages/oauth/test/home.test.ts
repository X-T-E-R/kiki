import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveKikiHome } from '../src/home';

describe('Kiki product home', () => {
  it('uses the unique product home and does not reinterpret explicit empty or zero values', () => {
    expect(resolveKikiHome(undefined, {}, '/example')).toBe(resolve('/example/.kiki'));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '/new' }, '/example')).toBe(resolve('/new'));
    expect(resolveKikiHome('/explicit', { KIKI_HOME: '/new' })).toBe(resolve('/explicit'));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '' })).toBe(resolve(''));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '0' })).toBe(resolve('0'));
  });
});
