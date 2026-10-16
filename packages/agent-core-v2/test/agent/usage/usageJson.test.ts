import { describe, expect, it } from 'vitest';
import { parseUsageJson, UsageJsonStream } from '#/agent/usage/usageJson';
import { normalizeUsageFact } from '#/agent/usage/usageFact';
import type { WireRecord } from '#/wire/record';

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

describe('streaming usage JSON', () => {
  function parse(text: string, chunk = 1) {
    const stream = new UsageJsonStream();
    for (let start = 0; start < text.length; start += chunk) stream.write(text.slice(start, start + chunk));
    return stream.finish();
  }

  it('preserves selected values, duplicate keys and split escapes against the native parser', () => {
    const tail = JSON.stringify(usage).slice(1);
    const inputs = [JSON.stringify(usage), `{"body":[{"type":"other"}],${tail}`, `{"type":"other","usage":null,${tail}`, `{"usage":{"output":99},${tail}`, JSON.stringify(usage).replace('"type"', '"t\\u0079pe"').replace('example', '中文😀\\n'), `{${tail.slice(0, -1)},"usage":{"output":2,"output":3,"inputOther":0,"inputCacheRead":0,"inputCacheCreation":0}}`];
    for (const text of inputs) {
      const expected = normalizeUsageFact(JSON.parse(text) as WireRecord);
      for (const chunk of [1, 7, 53]) expect(normalizeUsageFact(parse(text, chunk)!)).toEqual(expected);
    }
    for (const text of [`{${tail.slice(0, -1)},"type":"other"}`, `{"type":"usage.record","type":{}}`, '[]', 'true', '-0.1e-1', '"usage.record"']) expect(parse(text)).toBeUndefined();
  });

  it('rejects broken skipped JSON and unfinished tokens at arbitrary chunk boundaries', () => {
    for (const bad of ['{"type":"other",}', '{"type":"other","x":[1,]}', '{"x":01}', '{"x":1.}', '{"x":1e}', '{"x":+1}', '{"x":undefined}', '{"x":"\\x20"}', '{"x":"\\u123"}', '{"x":"a\tb"}', '{"x":true false}', '{"x":[}', '{"x":{]', '[] trailing', '', 'null', '{"x":"unfinished']) {
      for (const chunk of [1, 3, 16]) expect(() => parse(bad, chunk), bad).toThrow(SyntaxError);
    }
  });

  it('compresses long numeric tokens without changing Number rounding or underflow', () => {
    const values = ['0', '-0', '1.25e-10', '1e309', '5e-324', '2.4703282292062327e-324', `1${'0'.repeat(3000)}e-3000`, `0.${'0'.repeat(3000)}12345678901234567890e3001`, `1.${'0'.repeat(1100)}1`, `1${'2'.repeat(3000)}e-3000`];
    for (const number of values) {
      const raw = parse(`{"type":"usage.record","time":${number}}`, 13)!;
      expect(raw.time, number.slice(0, 40)).toBe(Number(number));
    }
  });

  it('streams a 27 MiB unrelated value in a usage record and keeps only the small fact', () => {
    const stream = new UsageJsonStream();
    stream.write('{"unrelated":"');
    const chunk = 'x'.repeat(64 << 10);
    for (let i = 0; i < 432; i++) stream.write(chunk);
    stream.write('","unrelated":{"nested":[true,null,1.2e3]},' + JSON.stringify(usage).slice(1));
    expect(stream.finish()).toEqual(usage);
    expect(JSON.stringify(stream).length).toBeLessThan(4096);
  });

  it('streams provisional fact batches with last-key-wins arrays and checkpoint fields in any order', () => {
    const records: Record<string, unknown>[] = [];
    const stream = new UsageJsonStream({ record: (value) => records.push(value), reset: () => { records.length = 0; } });
    const checkpoint = { generation: 'example', offset: 123, size: 123, mtimeMs: 100, boundaryHash: 'proof', valid: true };
    const text = `{"records":[${JSON.stringify({ ...usage, time: 1 })}],"checkpoint":${JSON.stringify(checkpoint)},"records":[${JSON.stringify({ ...usage, time: 2 })}],"version":1,"start":0}`;
    for (let i = 0; i < text.length; i += 11) stream.write(text.slice(i, i + 11));
    expect(stream.finishBatch()).toEqual({ version: 1, start: 0, checkpoint, records: [] });
    expect(records).toEqual([{ ...usage, time: 2 }]);
  });
});
