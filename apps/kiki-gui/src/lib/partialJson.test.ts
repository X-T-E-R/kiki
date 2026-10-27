import { describe, expect, it } from 'vitest';

import { decodeJsonStringFragment, extractArrayItemStringField, extractStringField, partialArrayItems, streamingMessageText } from './partialJson';

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

  it('reads specific items from a streaming messages array', () => {
    const stream = '{"messages":[{"text":"first"}, {"text":"second \\u00';
    expect(streamingMessageText(stream, 0)).toBe('first');
    expect(streamingMessageText(stream, 1)).toBe('second ');
    expect(streamingMessageText(stream, 2)).toBe('');
    expect(extractArrayItemStringField(stream, 'messages', 1, 'text', false)).toBeNull();
  });

  it('keeps each item monotonic for every delta and ignores nested names and structural characters inside strings', () => {
    const texts = ['first \\\" } , ]', 'second\nline é', '第三条'];
    const full = JSON.stringify({ metadata: { messages: [{ text: 'not the batch' }] }, messages: texts.map(text => ({ metadata: { text: 'not this body' }, text })) });
    const previous = ['', '', ''];
    for (let cut = 0; cut <= full.length; cut += 1) {
      for (let index = 0; index < texts.length; index += 1) {
        const value = streamingMessageText(full.slice(0, cut), index);
        expect(value.startsWith(previous[index]!)).toBe(true);
        previous[index] = value;
      }
    }
    expect(previous).toEqual(texts);
    expect(partialArrayItems('{"messages":[null,[],{"text":"third', 'messages')).toHaveLength(3);
    expect(streamingMessageText('{"messages":[null,[],{"text":"third', 2)).toBe('third');
    for (const index of [-1, 0.5, NaN, Infinity, 9]) expect(streamingMessageText(full, index)).toBe('');
    expect(partialArrayItems('{"messages":', 'messages')).toBeNull();
    expect(streamingMessageText('{"text":"legacy"}')).toBe('legacy');
    expect(streamingMessageText('{"text":"legacy"}', 0)).toBe('');
  });
});
