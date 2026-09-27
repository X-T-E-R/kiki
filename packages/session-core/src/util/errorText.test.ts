import { describe, expect, it } from 'vitest';

import { describeError, errorToText } from './errorText';

describe('describeError', () => {
  it('never renders a stringified object', () => {
    expect(describeError({})).toBeUndefined();
    expect(describeError('[object Object]')).toBeUndefined();
    expect(errorToText({}, 'fallback')).toBe('fallback');
  });

  it('reads command output: stderr before stdout', () => {
    expect(describeError({ kind: 'command_output', exit_code: 3, stderr: 'forced exit', stdout: 'partial' })).toBe('forced exit');
    expect(describeError({ stdout: 'only out' })).toBe('only out');
  });

  it('adds code and nested cause to an Error message', () => {
    const error = Object.assign(new Error('Request failed', { cause: new Error('socket hang up') }), { code: 'ECONNRESET' });
    expect(describeError(error)).toBe('Request failed (ECONNRESET) — socket hang up');
  });

  it('unwraps nested error envelopes', () => {
    expect(describeError({ error: { message: 'quota exceeded', code: 429 } })).toBe('quota exceeded (429)');
  });

  it('falls back to a truncated JSON summary', () => {
    const summary = describeError({ unexpected: 'x'.repeat(500) });
    expect(summary?.startsWith('{"unexpected":"xxx')).toBe(true);
    expect(summary?.endsWith('…')).toBe(true);
    expect(summary!.length).toBeLessThanOrEqual(301);
  });
});
