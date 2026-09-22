import { describe, expect, it } from 'vitest';

import {
  assertProviderCredential,
  assertProviderHeaders,
  isSensitiveProviderName,
  sanitizeProviderError,
  sanitizeProviderHeaders,
  sanitizeProviderUrl,
  validateProviderCredential,
  validateProviderHeader,
} from '../src/index';

const KEY = 'sk-live-4f8a2c9b1e';

describe('sanitizeProviderError', () => {
  it('redacts the credential in every form a provider may echo', () => {
    const forms = [
      KEY,
      `  ${KEY}  `,
      encodeURIComponent(KEY),
      Buffer.from(KEY, 'utf8').toString('base64'),
      Buffer.from(KEY, 'utf8').toString('base64url'),
      Buffer.from(KEY, 'utf8').toString('hex'),
    ];
    for (const form of forms) {
      const out = sanitizeProviderError(`provider rejected ${form}`, { apiKey: KEY });
      expect(out).not.toContain(KEY);
      expect(out).not.toContain(form.trim());
      expect(out).toContain('[redacted]');
    }

    const newlineKey = 'sk-live\n-4f8a2c9b1e';
    const whitespaceVariants = [
      newlineKey,
      'sk-live -4f8a2c9b1e',
      'sk-live-4f8a2c9b1e',
      String.raw`sk-live\n-4f8a2c9b1e`,
    ];
    for (const variant of whitespaceVariants) {
      const out = sanitizeProviderError(`provider rejected ${variant}`, { apiKey: newlineKey });
      expect(out).not.toContain('sk-live');
      expect(out).not.toContain('4f8a2c9b1e');
      expect(out).toContain('[redacted]');
    }
  });

  it('redacts a short credential as a whole token without rewriting words', () => {
    expect(sanitizeProviderError('invalid header value abc123', { apiKey: 'abc123' })).toBe(
      'invalid header value [redacted]',
    );
    expect(sanitizeProviderError('x-api-key: t', { headers: { 'x-api-key': 't' } })).toBe(
      'x-api-key: [redacted]',
    );
    expect(sanitizeProviderError('quota exceeded', { apiKey: 't' })).toBe('quota exceeded');
  });

  it('redacts an internal-newline credential quoted by the runtime', () => {
    const apiKey = 'sk-live\n-4f8a2c9b1e';
    const out = sanitizeProviderError(
      `Headers.append: "Bearer ${apiKey}" is an invalid header value`,
      { apiKey },
    );
    expect(out).not.toContain('sk-live');
    expect(out).not.toContain('4f8a2c9b1e');
    expect(out).not.toContain('\n');
  });

  it('consumes baseUrl credential material even when only the value is echoed', () => {
    const baseUrl = 'https://build:pa55word@gateway.example.test/v1?api_key=qz7bHQ2';

    expect(sanitizeProviderError(`cannot reach ${baseUrl}`, { baseUrl })).toBe(
      'cannot reach https://[redacted]@gateway.example.test/v1?api_key=[redacted]',
    );
    expect(sanitizeProviderError('password pa55word was rejected', { baseUrl })).toBe(
      'password [redacted] was rejected',
    );
    expect(sanitizeProviderError('api key qz7bHQ2 was rejected', { baseUrl })).toBe(
      'api key [redacted] was rejected',
    );
  });

  it('redacts header pairs whether bare or JSON-quoted', () => {
    expect(sanitizeProviderError('x-api-key: sk-4f8a2c9b1e', {})).toBe('x-api-key: [redacted]');
    expect(sanitizeProviderError('{"x-api-key":"sk-4f8a2c9b1e"}', {})).toBe(
      '{"x-api-key":[redacted]}',
    );
    expect(sanitizeProviderError('{"Authorization":"ApiKey zzqq11223344"}', {})).toBe(
      '{"Authorization":[redacted]}',
    );
    expect(sanitizeProviderError('proxy-authorization = "Basic Zm9vOmJhcg=="', {})).toBe(
      'proxy-authorization = [redacted]',
    );
  });

  it('redacts short header tokens and decoded URL credentials', () => {
    expect(sanitizeProviderError('Authorization: Bearer abc', {})).toBe('Authorization: [redacted]');
    expect(sanitizeProviderError('rejected pa ss from URL', { baseUrl: 'https://build:pa%20ss@host.test' }))
      .toBe('rejected [redacted] from URL');
  });

  it('redacts an unknown bearer-style literal', () => {
    expect(sanitizeProviderError('sent Bearer eyJhbGciOiJIUzI1NiJ9', {})).toBe(
      'sent Bearer [redacted]',
    );
  });

  it('strips credential-shaped env values and control characters', () => {
    expect(
      sanitizeProviderError('env OPENAI_API_KEY=sk-env-4f8a2c9b1e failed\nsecond line', {
        env: { OPENAI_API_KEY: 'sk-env-4f8a2c9b1e', EDITOR: 'vim' },
      }),
    ).toBe('env OPENAI_API_KEY=[redacted] failed second line');
  });

  it('reads the message of an Error, a thrown string, or a thrown record', () => {
    expect(sanitizeProviderError(new Error(`bad key ${KEY}`), { apiKey: KEY })).toBe(
      'bad key [redacted]',
    );
    expect(sanitizeProviderError(`bad key ${KEY}`, { apiKey: KEY })).toBe('bad key [redacted]');
    expect(sanitizeProviderError({ message: `bad key ${KEY}` }, { apiKey: KEY })).toBe(
      'bad key [redacted]',
    );
    expect(sanitizeProviderError({ status: 500 }, {})).toBe('{"status":500}');
  });

  it('falls back to a fixed message for an empty error', () => {
    expect(sanitizeProviderError(undefined)).toBe('Unknown provider error.');
    expect(sanitizeProviderError('   ')).toBe('Unknown provider error.');
  });
});

describe('sanitizeProviderUrl', () => {
  it('redacts userinfo and sensitive query values, leaving the rest intact', () => {
    expect(sanitizeProviderUrl('https://user:pass@h.test/v1?api_key=abc&model=k2#frag')).toBe(
      'https://[redacted]@h.test/v1?api_key=[redacted]&model=k2#frag',
    );
    expect(sanitizeProviderUrl('https://h.test/v1?model=k2')).toBe('https://h.test/v1?model=k2');
    expect(sanitizeProviderUrl('not a url')).toBe('not a url');
  });
});

describe('sanitizeProviderHeaders', () => {
  it('redacts credential-shaped header values only', () => {
    expect(
      sanitizeProviderHeaders({
        Authorization: 'Bearer sk-4f8a2c9b1e',
        'x-api-key': 'sk-4f8a2c9b1e',
        Accept: 'application/json',
      }),
    ).toEqual({
      Authorization: '[redacted]',
      'x-api-key': '[redacted]',
      Accept: 'application/json',
    });
  });
});

describe('isSensitiveProviderName', () => {
  it('matches credential names across separators and casing', () => {
    for (const name of [
      'Authorization',
      'x-api-key',
      'X_API_KEY',
      'APIKEY',
      'refresh_token',
      'Client-Secret',
      'cookie',
    ]) {
      expect(isSensitiveProviderName(name)).toBe(true);
    }
    for (const name of ['Accept', 'User-Agent', 'anthropic-version', 'model']) {
      expect(isSensitiveProviderName(name)).toBe(false);
    }
  });
});

describe('validateProviderCredential', () => {
  it('accepts a plain credential', () => {
    expect(validateProviderCredential(KEY)).toEqual({ ok: true });
  });

  it('rejects non-strings, blanks, and control characters without echoing the value', () => {
    const cases: Array<[unknown, string]> = [
      [undefined, 'must be a string'],
      [123, 'must be a string'],
      ['   ', 'must not be blank'],
      [`${KEY}\n`, 'control characters'],
      [`sk-live\n-4f8a2c9b1e`, 'control characters'],
    ];
    for (const [credential, expected] of cases) {
      const check = validateProviderCredential(credential);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain(expected);
      expect(check.reason).not.toContain('sk-live');
      expect(check.reason).not.toContain('4f8a2c9b1e');
    }
  });

  it('throws through assertProviderCredential without the value in the message', () => {
    expect(() => {
      assertProviderCredential(KEY);
    }).not.toThrow();
    expect(() => {
      assertProviderCredential(`sk-live\n-4f8a2c9b1e`);
    }).toThrow(/control characters/);
    try {
      assertProviderCredential(`sk-live\n-4f8a2c9b1e`);
      expect.unreachable('assertProviderCredential should throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('sk-live');
      expect((error as Error).message).not.toContain('4f8a2c9b1e');
    }
  });
});

describe('validateProviderHeader / assertProviderHeaders', () => {
  it('names the offending header but never its value', () => {
    const check = validateProviderHeader('Authorization', `Bearer ${KEY}\n`);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('Authorization');
    expect(check.reason).not.toContain(KEY);
    expect(validateProviderHeader('X-Trace', undefined).reason).toContain('X-Trace');
    expect(validateProviderHeader('Accept', 'application/json')).toEqual({ ok: true });
  });

  it('accepts a record or an iterable header bag', () => {
    expect(() => {
      assertProviderHeaders({ Accept: 'application/json' });
    }).not.toThrow();
    expect(() => {
      assertProviderHeaders(new Headers({ Accept: 'application/json' }));
    }).not.toThrow();
    expect(() => {
      assertProviderHeaders([['x-api-key', 'sk-live\n']]);
    }).toThrow(/control characters/);
    expect(() => {
      assertProviderHeaders({ Authorization: ['nope'] });
    }).toThrow(/must be a string/);
  });
});
