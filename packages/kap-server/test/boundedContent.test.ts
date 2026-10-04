import { describe, expect, it } from 'vitest';
import { applyContentSegment, jsonBytes, transcriptTurnSchema, type ContentWindow } from '@kiki/transcript';
import { boundedEntity, readContentSegment } from '../src/transport/klient/boundedContent';
import { boundedTranscriptSnapshot } from '../src/transport/klient/boundedTranscript';

describe('bounded canonical content', () => {
  it.each([['own prototype key', '__proto__'], ['own constructor key', 'constructor'], ['own prototype field', 'prototype'], ['257-character key', 'k'.repeat(257)]])('reads every original own JSON key through bounded object segments (%s)', (_label, key) => {
    const original = { output: JSON.parse(JSON.stringify({ [key]: { text: 'body'.repeat(1000) } })) as Record<string, unknown> };
    let current = boundedEntity(original, { kind: 'task', id: 'task-keys' });
    expect(jsonBytes(current)).toBeLessThan(12 * 1024);
    while (current.contentRefs?.length) {
      const segment = readContentSegment(original, current.contentRefs[0]!);
      expect(jsonBytes(segment)).toBeLessThan(64 * 1024);
      current = applyContentSegment(current, segment);
    }
    expect(current.output).toEqual(original.output);
    expect(Object.hasOwn(current.output, key)).toBe(true);
    expect(Object.getPrototypeOf(current.output)).toBe(Object.prototype);
    expect(({} as { text?: string }).text).toBeUndefined();
  });
  it('keeps a 50 MiB tool result bounded and reads the exact multibyte body in explicit segments', () => {
    const text = '汉😀\n\\"'.repeat(Math.ceil(50 * 1024 * 1024 / 11));
    const original = { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt: 'prompt', steps: [{ kind: 'step', turnId: 't0', stepId: 's0', ordinal: 0, state: 'completed', frames: [{ kind: 'tool', frameId: 'f0', toolCallId: 'call0', name: 'Read', state: 'done', input: { path: 'example.txt' }, output: { text } }] }] };
    let current = boundedEntity(original, { kind: 'turn', id: 't0' });
    expect(jsonBytes(current)).toBeLessThan(12 * 1024);
    expect(transcriptTurnSchema.safeParse(current).success).toBe(true);
    let pages = 0;
    while (current.contentRefs?.length) {
      const segment = readContentSegment(original, current.contentRefs[0]!);
      expect(jsonBytes(segment)).toBeLessThan(64 * 1024);
      current = applyContentSegment(current, segment);
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1000);
    expect(current.steps[0]!.frames[0]!.output.text).toBe(text);
    expect(current.steps[0]!.frames[0]!.input).toEqual(original.steps[0]!.frames[0]!.input);
  }, 60_000);

  it('reads an oversized single turn structure without dropping steps or frames', () => {
    const original = { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, steps: Array.from({ length: 100 }, (_, step) => ({ kind: 'step', turnId: 't0', stepId: `s${step}`, ordinal: step, state: 'completed', frames: Array.from({ length: 100 }, (_, frame) => ({ kind: 'text', frameId: `f${step}-${frame}`, role: 'assistant', text: `body ${step}-${frame}` })) })) };
    let current = boundedEntity(original, { kind: 'turn', id: 't0' });
    expect(jsonBytes(current)).toBeLessThan(12 * 1024);
    while (current.contentRefs?.length) current = applyContentSegment(current, readContentSegment(original, current.contentRefs[0]!));
    expect({ ...current, contentRefs: undefined }).toEqual(original);
  });

  it('binds production window leaf cuts to their canonical frame, preserving structural continuations', () => {
    const output = '正文😀'.repeat(20_000);
    const turn = transcriptTurnSchema.parse({ kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, steps: [{ kind: 'step', turnId: 't0', stepId: 's0', ordinal: 0, state: 'completed', frames: [{ kind: 'tool', frameId: 'f0', toolCallId: 'call0', name: 'Read', state: 'done', output }] }] });
    const snapshot = boundedTranscriptSnapshot({ items: [turn], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} }, 'main');
    const preview = snapshot.items[0]!;
    expect(preview.kind).toBe('turn');
    if (preview.kind !== 'turn') throw new Error('Expected turn');
    let frame = preview.steps[0]!.frames[0]!;
    expect(frame.contentRefs?.[0]?.source).toEqual({ kind: 'frame', id: 'f0', turnId: 't0', stepId: 's0' });
    expect(frame.contentRefs?.[0]?.path).toEqual(['output']);
    expect(preview.contentRefs).toEqual([]);
    while (frame.contentRefs?.length) frame = applyContentSegment(frame, readContentSegment(turn.steps[0]!.frames[0]!, frame.contentRefs[0]!));
    expect(frame).toMatchObject({ frameId: 'f0', toolCallId: 'call0', output });
    expect(jsonBytes(snapshot)).toBeLessThan(64 * 1024);
  });

  it('rejects changed revisions and does not concatenate a duplicate segment', () => {
    const original = { outputTail: 'a'.repeat(100_000) };
    const preview = boundedEntity(original, { kind: 'task', id: 'task0' });
    const ref = preview.contentRefs![0]!;
    expect(() => readContentSegment({ outputTail: 'b'.repeat(100_000) }, ref)).toThrow('Content changed');
    const segment = readContentSegment(original, ref);
    const once = applyContentSegment(preview, segment);
    expect(applyContentSegment(once, segment)).toBe(once);
    expect(() => applyContentSegment({ outputTail: '', contentRefs: [ref] } satisfies ContentWindow & { outputTail: string }, segment)).toThrow('offset mismatch');
  });
});


describe('visible reading integrity', () => {
  const snapshot = (items: import('@kiki/transcript').AgentTranscriptSnapshot['items'], attachments: import('@kiki/transcript').TranscriptAttachment[] = []) => ({ items, attachments, tasks: [], prompts: [], interactions: [], todos: [], meta: {} });
  const turn = (prompt: string, text: string) => transcriptTurnSchema.parse({ kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' }, prompt, steps: [{ kind: 'step', stepId: 's0', turnId: 't0', ordinal: 0, state: 'completed', frames: [{ kind: 'text', role: 'assistant', frameId: 'f0', text }] }] });

  it('keeps ordinary prose complete without a continuation and binds larger prose to exact sources', () => {
    const ordinary = turn('用户'.repeat(1500), 'ANSWER-'.repeat(600));
    const projected = boundedTranscriptSnapshot(snapshot([ordinary]), 'main');
    expect(projected.items[0]).toMatchObject({ prompt: ordinary.prompt, steps: [{ frames: [{ text: ordinary.steps[0]!.frames[0]!.kind === 'text' ? ordinary.steps[0]!.frames[0]!.text : '' }] }] });
    const large = turn('USER-'.repeat(6000), 'ANSWER-'.repeat(6000));
    const preview = boundedTranscriptSnapshot(snapshot([large]), 'main').items[0]!;
    if (preview.kind !== 'turn') throw new Error('Expected turn');
    let current = preview;
    while (current.contentRefs?.length) current = applyContentSegment(current, readContentSegment(large, current.contentRefs[0]!));
    expect(current.prompt).toBe(large.prompt);
    let frame = current.steps[0]!.frames[0]!;
    expect(frame.contentRefs?.[0]?.source).toEqual({ kind: 'frame', id: 'f0', turnId: 't0', stepId: 's0' });
    while (frame.contentRefs?.length) frame = applyContentSegment(frame, readContentSegment(large.steps[0]!.frames[0]!, frame.contentRefs[0]!));
    expect(frame).toMatchObject({ text: 'ANSWER-'.repeat(6000) });
    expect(jsonBytes(projected)).toBeLessThan(64 * 1024);
  });

  it('prioritizes attachments of visible messages over the optional collection tail, with a real byte bound', () => {
    const attachments = Array.from({ length: 9 }, (_, index) => ({ attachmentId: `att${index}`, mediaType: 'image/png', name: `image${index}.png`, source: { kind: 'session_media' as const, fileId: `file${index}` } }));
    const item = { ...turn('Look at the first image', 'answer'), attachmentIds: ['att0'] };
    const projected = boundedTranscriptSnapshot(snapshot([item], attachments), 'main');
    expect(projected.attachments.map((entry) => entry.attachmentId)).toContain('att0');
    expect(projected.globalCoverage?.attachments).toEqual({ returned: 8, total: 9, hasMore: true });
    const many = attachments.map((entry) => ({ ...entry, name: '汉😀'.repeat(2000) }));
    const bounded = boundedTranscriptSnapshot(snapshot([{ ...item, attachmentIds: many.map((entry) => entry.attachmentId) }], many), 'main');
    expect(jsonBytes(bounded.attachments)).toBeLessThanOrEqual(4 * 1024);
    expect(jsonBytes(bounded)).toBeLessThan(64 * 1024);
  });
});
