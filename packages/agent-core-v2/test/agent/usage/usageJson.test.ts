import { describe, expect, it } from 'vitest';
import { parseUsageJson } from '#/agent/usage/usageJson';

const usage = { type: 'usage.record', time: 1, model: 'example', usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } };

describe.each([0, 2100])('usage JSON validation (padding %i)', (padding) => {
  const parse = (text: string) => parseUsageJson(' '.repeat(padding) + text);
  it('selects only the final top-level type, including escaped keys and values', () => {
    const body = JSON.stringify(usage).slice(1);
    for (const text of [JSON.stringify(usage), `{ "body": {"type":"other"}, ${body}`, `{ "type":"other", ${body}`, JSON.stringify(usage).replace('"type"', '"t\\u0079pe"').replace('usage.record', 'usage\\u002erecord')]) {
      expect(parse(text)).toEqual(JSON.parse(text));
    }
    for (const text of [`{${body.slice(0, -1)},"type":"other"}`, '{"nested":{"type":"usage.record"}}', '{"text":"\\\"type\\\":\\\"usage.record\\\""}', '[]', 'true', '123', '"usage.record"']) {
      expect(parse(text)).toBeUndefined();
    }
  });

  it('validates every skipped value instead of treating a matching prefix as valid JSON', () => {
    for (const bad of ['{"type":"other",}', '{"type":"other","x":[1,]}', '{"x":01}', '{"x":1.}', '{"x":1e}', '{"x":+1}', '{"x":undefined}', '{"x":"\\x20"}', '{"x":"\\u123"}', '{"x":"a\tb"}', '{"x":true false}', '{"x":[}', '{"x":{]', '[] trailing', '', 'null']) {
      expect(() => parse(bad), bad).toThrow(SyntaxError);
    }
  });

  it('matches JSON.parse across nested non-usage data without materializing its large body', () => {
    const values: unknown[] = [null, true, false, -1.25e9, '中文😀\n\\"', [], {}, { x: '\u0000' }];
    for (let i = 0; i < 100; i++) {
      const value = { ['key' + i]: [values[i % values.length], { nested: values[(i + 1) % values.length] }], type: i % 2 ? 'other' : 'usage.record' };
      const text = JSON.stringify(value);
      expect(parse(text)).toEqual(value.type === 'usage.record' ? JSON.parse(text) : undefined);
    }
    const deep = '['.repeat(20_000) + '0' + ']'.repeat(20_000);
    expect(parse(deep)).toBeUndefined();
    expect(parse(JSON.stringify({ type: 'other', body: 'x'.repeat(8 * 1024 * 1024) }))).toBeUndefined();
    expect(parse(JSON.stringify({ type: 'other', body: '\n\\"'.repeat(100_000) }))).toBeUndefined();
  });
});
