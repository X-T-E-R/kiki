import { describe, expect, it } from 'vitest';

import { decodeJsonStringFragment, extractStringField, streamingMessageText } from './partialJson';

describe('partial JSON field scanner', () => {
  it('reads the growing prefix of a string field, one delta at a time', () => {
    const full = JSON.stringify({ to: '@阿澈', text: 'Hi "you"\nline two é' });
    let previous = '';
    for (let cut = 0; cut <= full.length; cut += 1) {
      const value = streamingMessageText(full.slice(0, cut));
      // Monotonic: each delta only extends what the reader already saw.
      expect(value.startsWith(previous)).toBe(true);
      previous = value;
    }
    expect(previous).toBe('Hi "you"\nline two é');
  });

  it('never exposes half-received escapes', () => {
    expect(streamingMessageText('{"text":"a\\')).toBe('a');
    expect(streamingMessageText('{"text":"a\\u00')).toBe('a');
    expect(decodeJsonStringFragment('x\\u00e9', true)).toBe('xé');
  });

  it('skips other keys, including a same-named value, and reports completeness', () => {
    expect(extractStringField('{"to":"text","text":"ok"}', 'text', true)).toEqual({ value: 'ok', complete: true });
    expect(extractStringField('{"text":"ok', 'text', false)).toBeNull();
    expect(streamingMessageText('{"to":"@b"')).toBe('');
    expect(streamingMessageText('')).toBe('');
  });
});
