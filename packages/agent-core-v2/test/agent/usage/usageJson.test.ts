import { describe, expect, it, vi } from 'vitest';
import { parseUsageJson, UsageJsonStream } from '#/agent/usage/usageJson';
import { normalizeUsageFact } from '#/agent/usage/usageFact';
import { UsageReadAllowance, UsageWireFramer, type UsageWireState } from '#/agent/usage/usageWireFramer';
import type { WireRecord } from '#/wire/record';

const usage = { type: 'usage.record', time: 1, model: 'example', usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } };

describe.each([{ padding: 0, bytes: false }, { padding: 2100, bytes: false }, { padding: 0, bytes: true }, { padding: 2100, bytes: true }])('usage JSON validation ($padding padding, bytes $bytes)', ({ padding, bytes }) => {
  const parse = (text: string) => parseUsageJson(bytes ? Buffer.from(' '.repeat(padding) + text) : ' '.repeat(padding) + text);
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

describe('usage JSON string selection', () => {
  it('preserves fully escaped type strings, duplicate keys and validation beyond matching lengths', () => {
    const escaped = (value: string) => value.replaceAll(/./g, (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`);
    const key = escaped('type'), value = escaped('usage.record');
    const text = `{"${key}":"${value}","body":"${'x'.repeat(3000)}",${JSON.stringify(usage).slice(1)}`;
    expect(parseUsageJson(text)).toEqual(JSON.parse(text));
    expect(parseUsageJson(`{"body":"${'x'.repeat(3000)}",${JSON.stringify(usage).slice(1, -1)},"${key}":"${value}"}`)).toEqual(JSON.parse(text));
    for (const tail of ['false', 'null', '{}', JSON.stringify('usage.record'.repeat(1000))]) {
      expect(parseUsageJson(`{"body":"${'x'.repeat(3000)}",${JSON.stringify(usage).slice(1, -1)},"${key}":${tail}}`)).toBeUndefined();
    }
    expect(parseUsageJson(JSON.stringify({ ['type' + 'x'.repeat(5000)]: 'usage.record', type: 'other' }))).toBeUndefined();
    expect(() => parseUsageJson(`{"${'k'.repeat(5000)}":"\\x20","type":"other"}`)).toThrow(SyntaxError);
  });

  it('does not decode plain root keys through JSON.parse', () => {
    const text = JSON.stringify({ type: 'other', time: 1, irrelevant: 'x'.repeat(5000), model: 'example', nested: { type: 'usage.record' } });
    const native = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((value: string) => native(value) as unknown);
    try {
      expect(parseUsageJson(text)).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('usage JSON byte selection', () => {
  it('materializes selected Unicode values from original UTF-8, including typed-array offsets', () => {
    const value = { ...usage, model: '模型🙂', body: '示例\n\\"'.repeat(1000) };
    const text = JSON.stringify(value).replace('"type"', '"t\\u0079pe"').replace('usage.record', 'usage\\u002erecord');
    const padded = Buffer.from('prefix' + text + 'suffix');
    const bytes = new Uint8Array(padded.buffer, padded.byteOffset + 6, padded.byteLength - 12);
    expect(parseUsageJson(bytes)).toEqual(value);
    expect(parseUsageJson(Buffer.from(text.slice(0, -1) + ',"type":"其他"}'))).toBeUndefined();
  });

  it('keeps UTF-8 replacement and JSON syntax behavior for every raw byte', () => {
    for (const type of ['other', 'usage.record']) {
      for (const field of ['type', 'body']) {
        for (let byte = 0; byte < 256; byte++) {
          const bytes = Buffer.concat([Buffer.from(`{"padding":"${'x'.repeat(2100)}","type":"${type}","${field}":"`), Buffer.from([byte]), Buffer.from('"}')]);
          const decoded = bytes.toString('utf8');
          let native: typeof usage;
          try { native = JSON.parse(decoded) as typeof usage; }
          catch { expect(() => parseUsageJson(bytes)).toThrow(SyntaxError); continue; }
          expect(parseUsageJson(bytes)).toEqual(native.type === 'usage.record' ? native : undefined);
        }
      }
    }
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

describe('usage wire framing', () => {
  it('resumes a transferable state at every UTF-8 byte boundary without retaining unrelated bodies', () => {
    const value = { ...usage, model: '模型🙂', extra: '示例\\\n'.repeat(1000) };
    const bytes = Buffer.from(JSON.stringify(value) + '\n' + JSON.stringify(usage) + '\n');
    const allowance = new UsageReadAllowance(Infinity, Infinity);
    let state: UsageWireState = { offset: 0, cursor: 0, valid: true };
    const facts = [];
    for (let start = 0; start < bytes.length; start++) {
      const framer = new UsageWireFramer(state.offset, 'example', structuredClone(state));
      const slice = framer.consume(bytes.subarray(start, start + 1), allowance, Infinity);
      state = slice.state;
      facts.push(...slice.records);
      expect(state.utf8?.byteLength ?? 0).toBeLessThanOrEqual(3);
      expect(JSON.stringify(state).length).toBeLessThan(4096);
    }
    expect(state.offset).toBe(bytes.length);
    expect(facts).toEqual([normalizeUsageFact(value, 'example'), normalizeUsageFact(usage, 'example')]);
  });

  it('reuses short usage parsing without collapsing duplicate, unknown or zero fact visits', () => {
    const zero = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    const values = [usage, { ...usage, usage: zero, usageKnown: false }, { ...usage, usage: zero, usageKnown: true }, { ...usage, usage: zero }];
    const bytes = Buffer.from([...values, ...values].map((value) => JSON.stringify({ ...value, body: 'private' })).join('\n') + '\n');
    const native = JSON.parse;
    const parse = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => native(text) as unknown);
    try {
      const allowance = new UsageReadAllowance(Infinity, 7);
      const framed = new UsageWireFramer(0, 'source').consume(bytes, allowance, Infinity);
      expect(framed).toMatchObject({ rawCount: 7, factCount: 7, stop: 'record_budget' });
      expect(framed.records).toEqual([...values, ...values.slice(0, 3)].map((value) => normalizeUsageFact(value, 'source')));
      expect(parse).toHaveBeenCalledTimes(4);
      expect(allowance.counts()).toEqual({ raw: 7, facts: 7 });
      expect(JSON.stringify(framed.state)).not.toContain('private');
      const remaining = new UsageWireFramer(framed.state.offset, 'source', framed.state).consume(bytes.subarray(framed.consumed), new UsageReadAllowance(Infinity), Infinity);
      expect(remaining.records).toEqual([normalizeUsageFact(values[3]!, 'source')]);
    } finally { parse.mockRestore(); }
  });

  it('evicts bounded short-row parsing entries and never reuses changed records or another source', () => {
    const framer = new UsageWireFramer(0, 'first');
    const values = Array.from({ length: 400 }, (_, time) => ({ ...usage, time, body: 'x'.repeat(1000) }));
    const native = JSON.parse;
    const parse = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => native(text) as unknown);
    try {
      const first = framer.consume(Buffer.from(JSON.stringify(values[0]) + '\n'), new UsageReadAllowance(Infinity), Infinity);
      expect(first.records).toEqual([normalizeUsageFact(values[0]!, 'first')]);
      for (const value of values.slice(1)) framer.consume(Buffer.from(JSON.stringify(value) + '\n'), new UsageReadAllowance(Infinity), Infinity);
      const reread = framer.consume(Buffer.from(JSON.stringify(values[0]) + '\n'), new UsageReadAllowance(Infinity), Infinity);
      expect(reread.records).toEqual(first.records);
      expect(parse).toHaveBeenCalledTimes(401);
      const other = new UsageWireFramer(0, 'second').consume(Buffer.from(JSON.stringify(values[0]) + '\n'), new UsageReadAllowance(Infinity), Infinity);
      expect(other.records[0]?.sourceAgentId).toBe('second');
    } finally { parse.mockRestore(); }
  });

  it('shares raw and fact visits between lane views and does not publish an over-budget record', () => {
    const allowance = new UsageReadAllowance(3, 1);
    const other = new UsageReadAllowance(allowance.buffer);
    const bytes = Buffer.from(JSON.stringify(usage) + '\n');
    const first = new UsageWireFramer(0).consume(bytes, allowance, Infinity);
    const second = new UsageWireFramer(0).consume(bytes, other, Infinity);
    expect(first.factCount).toBe(1);
    expect(second).toMatchObject({ factCount: 0, rawCount: 0, stop: 'record_budget', state: { offset: 0, cursor: 0 } });
    const nonUsage = Buffer.from('{"type":"other"}\n');
    expect(new UsageWireFramer(0).consume(nonUsage, other, Infinity).rawCount).toBe(1);
    expect(new UsageWireFramer(0).consume(nonUsage, allowance, Infinity).rawCount).toBe(1);
    expect(new UsageWireFramer(0).consume(nonUsage, other, Infinity).stop).toBe('record_budget');
  });
});
