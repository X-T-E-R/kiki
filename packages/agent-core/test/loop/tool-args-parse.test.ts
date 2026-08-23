import { describe, expect, it } from 'vitest';

import { classifyToolArgsJson, parseToolCallArguments } from '../../src/loop/tool-args-parse';

describe('parseToolCallArguments', () => {
  it('treats null or empty arguments as an empty object', () => {
    expect(parseToolCallArguments(null)).toEqual({
      success: true,
      data: {},
      parseFailed: false,
    });
    expect(parseToolCallArguments('')).toEqual({
      success: true,
      data: {},
      parseFailed: false,
    });
  });

  it('parses valid JSON', () => {
    expect(parseToolCallArguments('{"text":"hi"}')).toEqual({
      success: true,
      data: { text: 'hi' },
      parseFailed: false,
    });
  });

  it('falls back to an empty object when JSON is malformed', () => {
    expect(parseToolCallArguments('{"text":"hi",}')).toEqual({
      success: true,
      data: {},
      parseFailed: true,
      error: expect.any(String),
    });
  });

  it('falls back to an empty object for unrecoverable JSON', () => {
    const result = parseToolCallArguments('{}{');
    expect(result).toEqual({
      success: true,
      data: {},
      parseFailed: true,
      error: expect.any(String),
    });
  });

  it('classifies truncated and complete tool-args JSON tails', () => {
    const cases: Array<{
      readonly raw: string;
      readonly kind: 'complete' | 'container-unclosed' | 'value-truncated' | 'malformed';
      readonly field?: string;
    }> = [
      { raw: '{"pattern":"foo","path":"src"', kind: 'container-unclosed', field: 'path' },
      { raw: '{"pattern":"foo","path":"sr', kind: 'value-truncated', field: 'path' },
      { raw: '{"pattern":"foo","count":12', kind: 'container-unclosed', field: 'count' },
      { raw: '{"pattern":"foo","flag":tr', kind: 'value-truncated', field: 'flag' },
      { raw: '{"a":{"b":[1,2', kind: 'container-unclosed', field: 'b' },
      { raw: '{"pattern":"foo","nested":{"k":"v"}', kind: 'container-unclosed', field: 'nested' },
      { raw: '{}{', kind: 'malformed' },
      { raw: '{"a":1,}', kind: 'malformed' },
      { raw: '{"pattern":"a}{b"}', kind: 'complete' },
      { raw: '{"s":"tail \\" quote","x":1', kind: 'container-unclosed', field: 'x' },
      { raw: '{"s":"\\u00e4","y":[1,', kind: 'value-truncated', field: 'y' },
      { raw: '', kind: 'malformed' },
      { raw: '   \n\t', kind: 'malformed' },
    ];

    for (const testCase of cases) {
      const classified = classifyToolArgsJson(testCase.raw);
      expect(classified.kind, testCase.raw).toBe(testCase.kind);
      if (classified.kind === 'container-unclosed' || classified.kind === 'value-truncated') {
        expect(classified.offset, testCase.raw).toBe(testCase.raw.length);
        expect(classified.field, testCase.raw).toBe(testCase.field);
      }
    }
  });

  it('repairs only container-unclosed JSON and keeps truncated values failed', () => {
    expect(parseToolCallArguments('{"pattern":"foo","path":"src"')).toEqual({
      success: true,
      data: { pattern: 'foo', path: 'src' },
      parseFailed: false,
      repaired: true,
      truncation: { kind: 'container-unclosed', offset: 29, field: 'path' },
    });
    expect(parseToolCallArguments('{"pattern":"foo","path":"sr')).toEqual({
      success: true,
      data: {},
      parseFailed: true,
      error: expect.any(String),
      truncation: { kind: 'value-truncated', offset: 27, field: 'path' },
    });
  });
});
