import { describe, expect, it } from 'vitest';
import { AgentTranscript, applyContentSegment, jsonBytes, rebindTurnContentRefs, transcriptTurnSchema, type ContentRef, type ContentWindow, type TranscriptTurn } from '@kiki/transcript';
import { patchAgentTranscriptContent } from '../../session-core/src/session/transcript/content';
import { boundedEntity, boundedListPreview, readContentSegment } from '../src/transport/klient/boundedContent';
import { boundedAttachment, boundedTranscriptOps, boundedTranscriptPageSource, boundedTranscriptSnapshot } from '../src/transport/klient/boundedTranscript';
import { inlineMediaFile } from '../src/services/inlineMedia';

describe('bounded canonical content', () => {
  it('keeps full bare IDs when sidebar preview pressure reaches its smallest text window', () => {
    const original = {
      id: 'session_11111111-2222-4333-8444-555555555555', workspace_id: 'workspace_11111111-2222-4333-8444-555555555555',
      title: 'title'.repeat(1000), last_prompt: 'prompt'.repeat(1000),
      metadata: Object.fromEntries(Array.from({ length: 36 }, (_, index) => [`p${index}`, 'body'.repeat(1000)])),
    };
    const preview = boundedListPreview(original);
    expect(preview.id).toBe(original.id);
    expect(preview.workspace_id).toBe(original.workspace_id);
    expect(preview.title.length).toBeLessThan(original.title.length);
    expect(jsonBytes(preview)).toBeLessThanOrEqual(2048);
    expect(original.id).toHaveLength(44);
  });

  it('keeps nested bare IDs and existing source URL contracts while segmenting prose', () => {
    const original = {
      id: 'entity-' + 'i'.repeat(100),
      source: { id: 'source-' + 's'.repeat(100), referenceId: 'reference-' + 'r'.repeat(100), connection_id: 'connection-' + 'c'.repeat(100), url: 'https://example.test/' + 'u'.repeat(200) },
      text: 'body'.repeat(5000),
    };
    const preview = boundedEntity(original, { kind: 'roster', id: original.id }, 1600);
    expect(preview).toMatchObject({ id: original.id, source: original.source });
    expect(preview.text.length).toBeLessThan(original.text.length);
    expect(preview.contentRefs?.every((ref) => ref.path[0] === 'text')).toBe(true);
    expect(jsonBytes(preview)).toBeLessThanOrEqual(1600);
  });

  it('bounds oversized custom locators without losing the sidebar ID', () => {
    const original = {
      id: 'session_11111111-2222-4333-8444-555555555555',
      coverUrl: 'u'.repeat(70000), sourcePath: 'p'.repeat(70000), sourceRoot: 'r'.repeat(70000), sessionRef: 's'.repeat(70000),
    };
    const preview = boundedListPreview(original);
    expect(preview.id).toBe(original.id);
    expect(jsonBytes(preview)).toBeLessThanOrEqual(2048);
    for (const key of ['coverUrl', 'sourcePath', 'sourceRoot', 'sessionRef'] as const) {
      expect(preview[key].length).toBeLessThan(original[key].length);
    }
  });

  it('bounds raw turn content even when its canonical reference list is empty', () => {
    const turn = transcriptTurnSchema.parse({ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, prompt: 'raw'.repeat(10_000), steps: [], contentRefs: [] });
    const transcript = new AgentTranscript('main');
    transcript.apply([{ op: 'reset', agentId: 'main', snapshot: { items: [turn], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} } }]);
    const preview = boundedTranscriptPageSource(transcript.snapshot(), 'main').items[0]!;
    if (preview.kind !== 'turn') throw new Error('Expected canonical turn');
    expect(jsonBytes(preview)).toBeLessThan(jsonBytes(turn));
    expect(preview.contentRefs).toContainEqual(expect.objectContaining({ path: ['prompt'], total: 30_000 }));
    const completed = applyContentSegment(preview, readContentSegment(turn, preview.contentRefs![0]!));
    expect(completed).toMatchObject({ prompt: turn.prompt });
    expect(turn.prompt).toBe('raw'.repeat(10_000));
  });
  it.each(['queued', 'running', 'completed'])('keeps %s prompt image previews revision-addressed without shipping truncated base64', (status) => {
    const original = { promptId: 'sent-image', status, content: [{ type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'A'.repeat(10_000) } }] };
    const preview = boundedEntity(original, { kind: 'prompt', id: original.promptId }, 2048, 'main');
    expect(preview.content[0]).toMatchObject({ type: 'image', source: { kind: 'session_media', file_id: expect.stringMatching(/^inline-content:main:/u) } });
    expect(JSON.stringify(preview)).not.toContain('base64');
    expect(preview.contentRefs).toBeUndefined();
    expect(jsonBytes(preview)).toBeLessThan(2048);
    expect(original.content[0]!.source.data).toHaveLength(10_000);
  });
  it('projects the real external text marker shape and reads its exact saved body through marker content refs', () => {
    const text = 'START saved material\n' + '汉😀 native body\n'.repeat(4000) + 'END saved material';
    const original = { kind: 'marker' as const, markerId: 'external-text:record-1', marker: 'external.text', payload: {
      recordId: 'record-1', turnId: 0, text, kind: 'handoff' as const,
      title: undefined, relatedOperationIds: undefined, sourceUrl: undefined, clientTime: undefined,
      source: { connectionId: 'conn-1', clientName: 'Example Client', sessionRef: 'ref-1', driver: 'external' as const },
    } };
    expect(Object.keys(original.payload)).toHaveLength(9);
    const snapshot = { items: [original], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} };
    const item = boundedTranscriptSnapshot(snapshot, 'main').items[0]!;
    if (item.kind !== 'marker') throw new Error('Expected external marker');
    let preview = item;
    expect(preview).toMatchObject({ marker: 'external.text', payload: { recordId: 'record-1', kind: 'handoff', source: original.payload.source } });
    expect(jsonBytes(preview)).toBeLessThan(4096);
    expect(preview.contentRefs?.[0]).toMatchObject({ source: { kind: 'marker', id: original.markerId }, path: ['payload', 'text'], kind: 'text', total: text.length });
    let pages = 0;
    while (preview.contentRefs?.length) {
      const segment = readContentSegment(original, preview.contentRefs[0]!);
      expect(jsonBytes(segment)).toBeLessThan(256 * 1024);
      preview = applyContentSegment(preview, segment);
      pages += 1;
    }
    expect(pages).toBeGreaterThan(0);
    expect(preview).toMatchObject({ payload: { text } });
    const opaque = boundedEntity({ kind: 'marker', markerId: 'opaque', marker: 'other', payload: original.payload }, { kind: 'marker', id: 'opaque' });
    expect(opaque.payload).toEqual({});
    expect(opaque.contentRefs?.[0]?.path).toEqual(['payload']);
    const complete = boundedEntity({ ...original, payload: { ...original.payload, text: 'Ordinary saved record' } }, { kind: 'marker', id: original.markerId });
    expect(complete.payload.text).toBe('Ordinary saved record');
    expect(complete.contentRefs).toBeUndefined();
  });

  it('keeps compaction strategy fields when a large summary is segmented', () => {
    const summary = 'S'.repeat(20_000);
    const original = {
      kind: 'marker' as const,
      markerId: 'c1',
      marker: 'compaction',
      payload: {
        type: 'context.apply_compaction',
        summary,
        contextSummary: summary,
        compactedCount: 3,
        tokensBefore: 10,
        tokensAfter: 2,
        summaryOutputTokens: 1,
        strategy: 'summarize',
        shapeVersion: 1,
        reasonCodes: ['notes_missing'],
        fallbackFrom: 'relay',
        phase: 'completed',
        source: 'auto',
        time: 42,
      },
    };
    const preview = boundedEntity(original, { kind: 'marker', id: 'c1' });
    expect(preview.payload).toMatchObject({
      strategy: 'summarize',
      fallbackFrom: 'relay',
      source: 'auto',
      phase: 'completed',
      reasonCodes: ['notes_missing'],
    });
    expect(preview.payload.summary.length).toBeLessThan(summary.length);
    expect(preview.payload.summary).not.toMatch(/summarize|relay/);
    expect(preview.contentRefs?.some((ref) => ref.path.join('.') === 'payload.summary')).toBe(true);
  });
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
  it('keeps SendMessage receipts intact within the entity budget while ordinary outputs stay windowed', () => {
    const receipt = JSON.stringify({ messages: [
      { index: 0, message_id: 'send:call:item:0', delivered_to: ['user'], delivery: 'delivered',
        channels: [{ channel_id: 'internal', status: 'delivered' }], attachments: [{ blob_id: 'blob-1', path: 'example.png', kind: 'image' }] },
      { index: 1, message_id: 'send:call:item:1', delivered_to: [], delivery: 'not_sent', detail: 'Cannot route this message. ' + 'x'.repeat(400) },
      ...[2, 3, 4].map((index) => ({ index, message_id: `send:call:item:${index}`, delivered_to: [], delivery: 'not_sent' })),
    ] }, null, 2);
    expect(receipt.length).toBeGreaterThan(899);
    const input = { messages: Array.from({ length: 5 }, (_, index) => ({ text: `item ${index}` })) };
    const frame = { kind: 'tool', frameId: 'frame-send', toolCallId: 'call', name: 'SendMessage', state: 'done', input, output: receipt };
    const turn = transcriptTurnSchema.parse({ kind: 'turn', turnId: 't1', ordinal: 0, state: 'completed', origin: { kind: 'user' },
      steps: [{ kind: 'step', stepId: 's1', turnId: 't1', ordinal: 0, state: 'completed', frames: [frame] }] });
    const preview = boundedTranscriptSnapshot({ items: [turn], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} }, 'main').items[0]!;
    if (preview.kind !== 'turn') throw new Error('Expected turn');
    expect(preview.steps[0]?.frames[0]).toMatchObject({ input, output: receipt });
    expect(preview.steps[0]?.frames[0]?.contentRefs).toBeUndefined();
    const ordinary = boundedEntity({ ...frame, name: 'Read' }, { kind: 'frame', id: frame.frameId });
    expect(ordinary.output.length).toBeLessThan(receipt.length);
    expect(ordinary.contentRefs).toContainEqual(expect.objectContaining({ path: ['output'] }));
    const oversized = { ...frame, output: JSON.stringify({ message_id: 'send:call', delivered_to: ['user'], detail: 'x'.repeat(200_000) }) };
    const bounded = boundedEntity(oversized, { kind: 'frame', id: frame.frameId });
    expect(jsonBytes(bounded)).toBeLessThan(128 * 1024);
    const outputRef = bounded.contentRefs?.find((ref) => ref.path.length === 1 && ref.path[0] === 'output');
    expect(outputRef).toBeDefined();
    expect(applyContentSegment(bounded, readContentSegment(oversized, outputRef!)).output).not.toBe(bounded.output);
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
      expect(jsonBytes(segment)).toBeLessThan(256 * 1024);
      current = applyContentSegment(current, segment);
      pages += 1;
    }
    expect(pages).toBeGreaterThan(100);
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

  it('binds a snapshot roster continuation to row identities rather than every row body', () => {
    const rows = (status: string, order: (index: number) => number = (index) => index, length = 900) => Array.from({ length }, (_, index) => {
      const id = `agent-${order(index)}`;
      return { id, agent_id: id, status, description: `task ${index}`, output_preview: 'receipt '.repeat(256) };
    });
    const preview = boundedEntity({ subagents: rows('running') }, { kind: 'snapshot', id: '' });
    const ref = preview.contentRefs!.find((candidate) => candidate.path.length === 1 && candidate.path[0] === 'subagents')!;
    expect(ref).toMatchObject({ kind: 'array', total: 900 });
    const segment = readContentSegment({ subagents: rows('completed') }, ref);
    expect((segment.value as { status: string }[])[0]).toMatchObject({ id: `agent-${ref.offset}`, status: 'completed' });
    expect(() => readContentSegment({ subagents: rows('running', (index) => 899 - index) }, ref)).toThrow('Content changed');
    expect(() => readContentSegment({ subagents: rows('running', undefined, 901) }, ref)).toThrow('Content changed');
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

describe('header-first projection', () => {
  it.each([3, 7])('keeps %i step and frame headers independently of opaque parameters and outputs', (count) => {
    const original = transcriptTurnSchema.parse({ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps: Array.from({ length: count }, (_, step) => ({ kind: 'step', stepId: `s${step}`, turnId: 't1', ordinal: step, state: 'completed', frames: Array.from({ length: 3 }, (_, frame) => ({ kind: 'tool', frameId: `f${step}-${frame}`, toolCallId: `call${step}-${frame}`, name: 'Read', state: 'done', input: Object.fromEntries(Array.from({ length: 40 }, (_, field) => [`key${field}`, count === 3 ? `value${field}` : 'synthetic '.repeat(1000)])), output: 'ok' })) })) });
    const preview = boundedEntity(original, { kind: 'turn', id: 't1' });
    expect(preview.steps).toHaveLength(count);
    expect(preview.steps.map((step) => step.frames.length)).toEqual(Array(count).fill(3));
    expect(jsonBytes(preview)).toBeLessThan(24 * 1024);
    expect(preview.contentRefs?.some((ref) => ref.path.length === 1 && ref.path[0] === 'steps')).not.toBe(true);
  });

  it('fills omitted steps around a live tail without discarding its newer streamed frames', () => {
    const original = transcriptTurnSchema.parse({ kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' }, steps: Array.from({ length: 14 }, (_, ordinal) => ({ kind: 'step', stepId: `s${ordinal}`, turnId: 't1', ordinal, state: 'running', frames: [{ kind: 'text', frameId: `f${ordinal}`, role: 'assistant', text: 'older response' }] })) });
    const preview = boundedEntity(original, { kind: 'turn', id: 't1' });
    const ref = preview.contentRefs!.find((ref) => ref.path.length === 1 && ref.path[0] === 'steps')!;
    expect(ref).toMatchObject({ offset: 8, total: 14 });
    const tail = { ...original.steps[13]!, frames: [{ ...original.steps[13]!.frames[0]!, text: 'newer streamed response' }] };
    const live = { ...preview, steps: [...preview.steps, tail] };
    const completed = applyContentSegment(live, readContentSegment(original, ref));
    expect(completed.steps.map(step => step.stepId)).toEqual(original.steps.map(step => step.stepId));
    expect(completed.steps[13]!.frames[0]).toMatchObject({ text: 'newer streamed response' });
    expect(completed.contentRefs?.some(ref => ref.path.length === 1 && ref.path[0] === 'steps')).not.toBe(true);
  });

  it('does not attach an older nested text continuation to an already streamed replacement', () => {
    const frames = Array.from({ length: 14 }, (_, index) => ({ kind: 'text', frameId: `f${index}`, role: 'assistant', text: 'older saved response '.repeat(4000) }));
    const original = { steps: [{ kind: 'step', stepId: 's1', ordinal: 0, frames }] };
    const preview = boundedEntity(original, { kind: 'turn', id: 't1' });
    let ref = preview.contentRefs!.find(ref => ref.path.length === 3 && ref.path[2] === 'frames');
    const tail = { ...frames[13]!, text: 'new live response' };
    let completed = { ...preview, steps: [{ ...preview.steps[0]!, frames: [...preview.steps[0]!.frames, tail] }] };
    while (ref !== undefined) {
      const segment = readContentSegment(original, ref);
      completed = applyContentSegment(completed, segment);
      ref = segment.next;
    }
    expect(completed.steps[0]!.frames[13]!.text).toBe('new live response');
    expect(completed.contentRefs?.some(ref => ref.path[3] === 13)).toBe(false);
    expect(completed.contentRefs?.some(ref => ref.path[3] === 8 && ref.path[4] === 'text')).toBe(true);
  });

  it('continues the fixed structure prefix when a later live step arrives without claiming that step was in the old watermark', () => {
    const steps = Array.from({ length: 14 }, (_, ordinal) => ({ kind: 'step', stepId: `s${ordinal}`, ordinal, frames: [] }));
    const original = { steps };
    const preview = boundedEntity(original, { kind: 'turn', id: 't1' });
    const ref = preview.contentRefs!.find(ref => ref.path.length === 1 && ref.path[0] === 'steps')!;
    const appended = { steps: [...steps, { kind: 'step', stepId: 's14', ordinal: 14, frames: [] }] };
    const segment = readContentSegment(appended, ref);
    expect(segment.next).toBeUndefined();
    expect((segment.value as { stepId: string }[]).map(step => step.stepId)).toEqual(steps.slice(8).map(step => step.stepId));
    const completed = applyContentSegment({ ...preview, steps: [...preview.steps, appended.steps[14]!] }, segment);
    expect(completed.steps.map(step => step.stepId)).toEqual(appended.steps.map(step => step.stepId));
    expect(() => readContentSegment({ steps: [steps[1]!, steps[0]!, ...appended.steps.slice(2)] }, ref)).toThrow('Content changed');
  });

  it('merges omitted frame prefixes in source order while preserving an already streamed tail', () => {
    const frames = Array.from({ length: 14 }, (_, index) => ({ kind: 'text', frameId: `f${index}`, role: 'assistant', text: `saved ${index}` }));
    const original = { steps: [{ kind: 'step', stepId: 's1', ordinal: 0, frames }] };
    const preview = boundedEntity(original, { kind: 'turn', id: 't1' });
    const ref = preview.contentRefs!.find(ref => ref.path.length === 3 && ref.path[2] === 'frames')!;
    const tail = { ...frames[13]!, text: 'streamed tail' };
    const live = { ...preview, steps: [{ ...preview.steps[0]!, frames: [...preview.steps[0]!.frames, tail] }] };
    const completed = applyContentSegment(live, readContentSegment(original, ref));
    expect(completed.steps[0]!.frames.map(frame => frame.frameId)).toEqual(frames.map(frame => frame.frameId));
    expect(completed.steps[0]!.frames[13]!.text).toBe('streamed tail');
  });

  it('structural continuation revision ignores body changes but detects reordered identities', () => {
    const turn = (output: string, reverse = false) => ({ steps: Array.from({ length: 20 }, (_, ordinal) => ({ kind: 'step', stepId: `s${reverse ? 19 - ordinal : ordinal}`, ordinal, frames: [{ frameId: 'f', output }] })) });
    const original = turn('old');
    const ref = boundedEntity(original, { kind: 'turn', id: 't1' }).contentRefs!.find((ref) => ref.path.length === 1)!;
    expect(() => readContentSegment(turn('new'), ref)).not.toThrow();
    expect(() => readContentSegment(turn('new', true), ref)).toThrow('Content changed');
  });

  it('uses tail structure windows for snapshots while keeping boundedEntity head-compatible', () => {
    const original = transcriptTurnSchema.parse({
      kind: 'turn', turnId: 'tail-turn', ordinal: 0, state: 'completed', origin: { kind: 'user' },
      steps: Array.from({ length: 107 }, (_, step) => ({
        kind: 'step', turnId: 'tail-turn', stepId: `s${step}`, ordinal: step, state: 'completed',
        frames: Array.from({ length: 40 }, (_, frame) => ({ kind: 'text', frameId: `f${step}-${frame}`, role: 'assistant', text: `saved ${step}-${frame}` })),
      })),
    });
    const snapshot = boundedTranscriptSnapshot({ items: [original], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} }, 'main');
    const preview = snapshot.items[0]!;
    if (preview.kind !== 'turn') throw new Error('Expected turn');
    expect(preview.steps.map((step) => step.stepId)).toEqual(Array.from({ length: 8 }, (_, index) => `s${index + 99}`));
    expect(preview.steps.at(-1)!.frames.map((frame) => frame.frameId)).toEqual(Array.from({ length: 8 }, (_, index) => `f106-${index + 32}`));
    const stepRef = preview.contentRefs?.find((ref) => ref.path.length === 1 && ref.path[0] === 'steps');
    expect(stepRef).toMatchObject({ offset: 99, total: 107, direction: 'backward' });
    const frameRef = preview.contentRefs?.find((ref) => ref.path.length === 3 && ref.path[0] === 'steps' && ref.path[1] === 106 && ref.path[2] === 'frames');
    expect(frameRef).toMatchObject({ offset: 32, total: 40, direction: 'backward' });

    const head = boundedEntity(original, { kind: 'turn', id: 'tail-turn' }, undefined, 'main');
    expect(head.steps.map((step) => step.stepId)).toEqual(Array.from({ length: 8 }, (_, index) => `s${index}`));
    expect(head.steps[0]!.frames.map((frame) => frame.frameId)).toEqual(Array.from({ length: 8 }, (_, index) => `f0-${index}`));
    const headRef = head.contentRefs?.find((ref) => ref.path.length === 1 && ref.path[0] === 'steps');
    expect(headRef).toMatchObject({ offset: 8, total: 107 });
    expect((headRef as { direction?: string } | undefined)?.direction).toBeUndefined();
    expect((readContentSegment(original, headRef!).value as { stepId: string }[]).map((step) => step.stepId)).toEqual(Array.from({ length: 20 }, (_, index) => `s${index + 8}`));

  });

  it('reads backward structure pages to zero without repeating the inline suffix', () => {
    const original = {
      steps: Array.from({ length: 107 }, (_, step) => ({
        kind: 'step', stepId: `s${step}`, ordinal: step,
        frames: Array.from({ length: 40 }, (_, frame) => ({ kind: 'text', frameId: `f${step}-${frame}`, text: `saved ${step}-${frame}` })),
      })),
    };
    const preview = boundedEntity(original, { kind: 'turn', id: 'tail-turn' }, undefined, 'main', 'tail');
    const stepRef = preview.contentRefs?.find((ref) => ref.path.length === 1 && ref.path[0] === 'steps');
    if (stepRef === undefined) throw new Error('Expected backward steps ref');
    const omitted: string[] = [];
    let ref: ContentRef | undefined = stepRef;
    let pages = 0;
    while (ref !== undefined) {
      const segment = readContentSegment(original, ref, false, 'main', 64 * 1024);
      const values = segment.value as { stepId: string }[];
      expect(segment.start).toBe(ref.offset - values.length);
      expect(segment.start).toBeGreaterThanOrEqual(0);
      if (segment.next === undefined) expect(segment.start).toBe(0);
      else expect(segment.next.offset).toBe(segment.start);
      expect(values.some((step) => Number(step.stepId.slice(1)) >= stepRef.offset)).toBe(false);
      omitted.unshift(...values.map((step) => step.stepId));
      ref = segment.next;
      pages += 1;
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(1);
    expect(omitted).toEqual(original.steps.slice(0, stepRef.offset).map((step) => step.stepId));

    const frameRef = preview.contentRefs?.find((candidate) => candidate.path.length === 3 && candidate.path[0] === 'steps' && candidate.path[1] === 106 && candidate.path[2] === 'frames');
    if (frameRef === undefined) throw new Error('Expected backward frames ref');
    const frameIds: string[] = [];
    ref = frameRef;
    while (ref !== undefined) {
      const segment = readContentSegment(original, ref, false, 'main', 64 * 1024);
      const values = segment.value as { frameId: string }[];
      expect(segment.start).toBe(ref.offset - values.length);
      if (segment.next === undefined) expect(segment.start).toBe(0);
      else expect(segment.next.offset).toBe(segment.start);
      frameIds.unshift(...values.map((frame) => frame.frameId));
      ref = segment.next;
    }
    expect(frameIds).toEqual(original.steps[106]!.frames.slice(0, frameRef.offset).map((frame) => frame.frameId));
  });

  it('keeps the fixed canonical watermark appendable and rejects replacement', () => {
    const original = { steps: Array.from({ length: 24 }, (_, ordinal) => ({ kind: 'step', stepId: `s${ordinal}`, ordinal, frames: [] })) };
    const preview = boundedEntity(original, { kind: 'turn', id: 'watermark-turn' }, undefined, 'main', 'tail');
    const ref = preview.contentRefs?.find((candidate) => candidate.path.length === 1 && candidate.path[0] === 'steps');
    if (ref === undefined) throw new Error('Expected backward steps ref');
    expect(() => readContentSegment({ steps: [...original.steps, { kind: 'step', stepId: 's24', ordinal: 24, frames: [] }] }, ref)).not.toThrow();
    expect(() => readContentSegment(original, { ...ref, offset: 0 })).toThrow('Content changed');
    const nonCanonical = { values: Array.from({ length: 100 }, (_, index) => index) };
    const nonCanonicalRef = boundedEntity(nonCanonical, { kind: 'task', id: 'non-canonical' }).contentRefs?.find((candidate) => candidate.path[0] === 'values');
    if (nonCanonicalRef === undefined) throw new Error('Expected non-canonical array ref');
    expect(() => readContentSegment(nonCanonical, { ...nonCanonicalRef, direction: 'backward' })).toThrow('Content changed');
    const replaced = { steps: [original.steps[0]!, { kind: 'step', stepId: 'replacement', ordinal: 1, frames: [] }, ...original.steps.slice(2)] };
    expect(() => readContentSegment(replaced, ref)).toThrow('Content changed');
  });

  it('hydrates tail structures through the transcript store without compact-path or live-tail loss', () => {
    const longText = `long-tail-${'正文😀'.repeat(6000)}`;
    const original: TranscriptTurn = transcriptTurnSchema.parse({
      kind: 'turn', turnId: 'hydrate-turn', ordinal: 0, state: 'completed', origin: { kind: 'user' },
      steps: Array.from({ length: 107 }, (_, step) => ({
        kind: 'step', turnId: 'hydrate-turn', stepId: `s${step}`, ordinal: step, state: 'completed',
        frames: Array.from({ length: step === 106 ? 40 : 12 }, (_, frame) => ({
          kind: 'text', frameId: `f${step}-${frame}`, role: 'assistant',
          text: step === 106 && frame === 39 ? longText : `saved-${step}-${frame}`,
        })),
      })),
    });
    const snapshotFor = (turn: TranscriptTurn): import('@kiki/transcript').AgentTranscriptSnapshot => ({ items: [turn], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} });
    const initial = boundedTranscriptSnapshot(snapshotFor(original), 'main').items[0]!;
    if (initial.kind !== 'turn') throw new Error('Expected turn');
    let current: TranscriptTurn = rebindTurnContentRefs(initial);
    const structuralRefs = (current.contentRefs ?? []).filter((ref) => ref.path.length === 3 && ref.path[0] === 'steps' && ref.path[2] === 'frames');
    expect(structuralRefs.length).toBeGreaterThan(0);
    expect(structuralRefs.every((ref) => typeof ref.path[1] === 'number' && ref.path[1] >= 99)).toBe(true);
    const longFrame = current.steps.at(-1)!.frames.at(-1)!;
    expect(longFrame.contentRefs?.[0]).toMatchObject({ source: { kind: 'frame', id: 'f106-39', turnId: 'hydrate-turn', stepId: 's106' }, path: ['text'] });

    const transcript = new AgentTranscript('main');
    const syncStore = (turn: TranscriptTurn): TranscriptTurn => {
      transcript.apply([{ op: 'reset', agentId: 'main', snapshot: snapshotFor(turn) }]);
      const stored = transcript.getTurn(turn.turnId);
      if (stored === undefined) throw new Error('Expected stored turn');
      return stored;
    };
    current = syncStore(current);
    transcript.apply([
      { op: 'step.upsert', turnId: 'hydrate-turn', step: { kind: 'step', turnId: 'hydrate-turn', stepId: 's107', ordinal: 107, state: 'running' } },
      { op: 'frame.upsert', turnId: 'hydrate-turn', stepId: 's107', frame: { kind: 'text', frameId: 'f107-live', role: 'assistant', text: 'LIVE STEP TEXT' } },
      { op: 'frame.upsert', turnId: 'hydrate-turn', stepId: 's106', frame: { kind: 'text', frameId: 'f106-live', role: 'assistant', text: 'LIVE FRAME TEXT' } },
    ]);
    current = transcript.getTurn('hydrate-turn')!;

    const firstRef = (turn: TranscriptTurn): ContentRef | undefined => {
      const root = turn.contentRefs?.[0];
      if (root !== undefined) return root;
      for (const step of turn.steps) for (const frame of step.frames) {
        const nested = frame.contentRefs?.[0];
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    const sourceEntity = (ref: ContentRef): object => {
      if (ref.source.kind === 'turn') return original;
      if (ref.source.kind !== 'frame' || ref.source.stepId === undefined) throw new Error('Expected frame content source');
      const step = original.steps.find((entry) => entry.stepId === ref.source.stepId);
      const frame = step?.frames.find((entry) => entry.frameId === ref.source.id);
      if (frame === undefined) throw new Error('Expected canonical frame');
      return frame;
    };
    const expectLive = (turn: TranscriptTurn) => {
      expect(turn.steps.find((step) => step.stepId === 's107')?.frames.find((frame) => frame.frameId === 'f107-live')).toMatchObject({ text: 'LIVE STEP TEXT' });
      expect(turn.steps.find((step) => step.stepId === 's106')?.frames.find((frame) => frame.frameId === 'f106-live')).toMatchObject({ text: 'LIVE FRAME TEXT' });
    };

    let pages = 0;
    for (;;) {
      const ref = firstRef(current);
      if (ref === undefined) break;
      const segment = readContentSegment(sourceEntity(ref), ref, false, 'main', 64 * 1024);
      expect(patchAgentTranscriptContent(transcript, segment)).toBe(true);
      current = transcript.getTurn('hydrate-turn')!;
      expectLive(current);
      pages += 1;
      expect(pages).toBeLessThan(1000);
    }

    expect(pages).toBeGreaterThan(100);
    expect(firstRef(current)).toBeUndefined();
    expect(current.steps.map((step) => step.stepId)).toEqual([...original.steps.map((step) => step.stepId), 's107']);
    for (const expectedStep of original.steps) {
      const actualStep = current.steps.find((step) => step.stepId === expectedStep.stepId);
      expect(actualStep).toBeDefined();
      const expectedFrames = expectedStep.frames.map((frame) => frame.frameId);
      const actualFrames = actualStep!.frames.map((frame) => frame.frameId);
      expect(actualFrames).toEqual(expectedFrames.concat(expectedStep.stepId === 's106' ? ['f106-live'] : []));
      expect(new Set(actualFrames).size).toBe(actualFrames.length);
      for (const expectedFrame of expectedStep.frames) {
        const actualFrame = actualStep!.frames.find((frame) => frame.frameId === expectedFrame.frameId);
        expect(actualFrame).toBeDefined();
        if (expectedFrame.kind === 'text') expect(actualFrame).toMatchObject({ frameId: expectedFrame.frameId, text: expectedFrame.text });
      }
    }
    expect(current.steps.find((step) => step.stepId === 's107')?.frames.map((frame) => frame.frameId)).toEqual(['f107-live']);
  });

  it('does not insert an out-of-window live frame before reverse hydration', () => {
    const original: TranscriptTurn = transcriptTurnSchema.parse({
      kind: 'turn', turnId: 'window-turn', ordinal: 0, state: 'completed', origin: { kind: 'user' },
      steps: Array.from({ length: 107 }, (_, step) => ({
        kind: 'step', turnId: 'window-turn', stepId: `s${step}`, ordinal: step, state: 'completed',
        frames: Array.from({ length: step === 106 ? 40 : 12 }, (_, frame) => ({ kind: 'text', frameId: `f${step}-${frame}`, role: 'assistant', text: `saved-${step}-${frame}` })),
      })),
    });
    const updated: TranscriptTurn = {
      ...original,
      steps: original.steps.map((step) => step.stepId === 's106' ? {
        ...step,
        frames: step.frames.map((frame, index) => index === 0 ? { ...frame, text: 'LIVE OLD FRAME TEXT' } : frame),
      } : step),
    };
    const snapshot = (turn: TranscriptTurn) => ({ items: [turn], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} });
    const canonical = new AgentTranscript('main');
    canonical.apply([{ op: 'reset', agentId: 'main', snapshot: snapshot(original) }]);
    const preview = boundedTranscriptSnapshot(snapshot(original), 'main').items[0]!;
    if (preview.kind !== 'turn') throw new Error('Expected turn');
    const live = new AgentTranscript('main');
    live.apply([{ op: 'reset', agentId: 'main', snapshot: snapshot(rebindTurnContentRefs(preview)) }]);
    const sourceFrame = updated.steps[106]!.frames[0]!;
    const bounded = boundedTranscriptOps([{ op: 'frame.upsert', turnId: 'window-turn', stepId: 's106', frame: sourceFrame }], canonical)[0]!;
    if (bounded.op !== 'frame.upsert') throw new Error('Expected frame upsert');
    expect((bounded as { stepIndex?: number; frameIndex?: number }).stepIndex).toBe(106);
    expect((bounded as { stepIndex?: number; frameIndex?: number }).frameIndex).toBe(0);
    const oldAppend = boundedTranscriptOps([{
      op: 'append', target: { type: 'frame' as const, turnId: 'window-turn', stepId: 's106', frameId: 'f106-0' }, offset: 0, text: 'old append',
    }], canonical)[0]!;
    expect(oldAppend).toMatchObject({ op: 'frame.upsert', stepIndex: 106, frameIndex: 0, turnId: 'window-turn', stepId: 's106' });
    const omittedStepAppend = boundedTranscriptOps([{
      op: 'append', target: { type: 'frame' as const, turnId: 'window-turn', stepId: 's0', frameId: 'f0-0' }, offset: 0, text: 'old step append',
    }], canonical)[0]!;
    expect(omittedStepAppend).toMatchObject({ op: 'frame.upsert', stepIndex: 0, frameIndex: 0, turnId: 'window-turn', stepId: 's0' });
    const tailAppend = boundedTranscriptOps([{
      op: 'append', target: { type: 'frame' as const, turnId: 'window-turn', stepId: 's106', frameId: 'f106-39' }, offset: 0, text: 'tail append',
    }], canonical)[0]!;
    expect(tailAppend).toMatchObject({ op: 'append', stepIndex: 106, frameIndex: 39, target: { frameId: 'f106-39' } });
    live.apply([bounded]);
    const compact = live.getTurn('window-turn')!;
    expect(compact.steps.find((step) => step.stepId === 's106')?.frames.map((frame) => frame.frameId)).toEqual(Array.from({ length: 8 }, (_, index) => `f106-${index + 32}`));

    let current = compact;
    let ref = current.contentRefs?.find((candidate) => candidate.path.length === 3 && candidate.path[0] === 'steps' && candidate.path[1] === 106 && candidate.path[2] === 'frames');
    if (ref === undefined) throw new Error('Expected backward frames ref');
    while (ref !== undefined) {
      const segment = readContentSegment(updated, ref, false, 'main', 64 * 1024);
      expect(patchAgentTranscriptContent(live, segment)).toBe(true);
      current = live.getTurn('window-turn')!;
      ref = current.contentRefs?.find((candidate) => candidate.path.length === 3 && candidate.path[0] === 'steps' && candidate.path[1] === 106 && candidate.path[2] === 'frames');
    }
    expect(current.steps.find((step) => step.stepId === 's106')?.frames.map((frame) => frame.frameId)).toEqual(Array.from({ length: 40 }, (_, index) => `f106-${index}`));
    expect(current.steps.find((step) => step.stepId === 's106')?.frames[0]).toMatchObject({ frameId: 'f106-0', text: 'LIVE OLD FRAME TEXT' });
  });
});

it('bounds random visible text ranges and keeps Unicode boundaries readable', () => {
  const original = { output: 'a'.repeat(4095) + '😀' + 'b'.repeat(8000) };
  const ref = boundedEntity(original, { kind: 'frame', id: 'f', turnId: 't', stepId: 's' }).contentRefs![0]!;
  const first = readContentSegment(original, { ...ref, offset: 0 }, true);
  expect(first.value).toBe(original.output.slice(0, 4097));
  expect(jsonBytes(first)).toBeLessThan(8 * 1024);
  const boundary = readContentSegment(original, { ...ref, offset: 4096 }, true);
  expect(boundary.ref.offset).toBe(4095);
  expect((boundary.value as string).startsWith('😀')).toBe(true);
});


describe('content budgets schedule rather than reject canonical values', () => {
  it('hydrates nested reference headers larger than the old entity budget with exact own keys', () => {
    const fields = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${index}-${'k'.repeat(900)}`, Object.fromEntries(Array.from({ length: 8 }, (_, child) => [`${child}-${'v'.repeat(900)}`, '汉😀'.repeat(2000)]))]));
    const original = { kind: 'tool', frameId: 'f', toolCallId: 'call', name: 'Example', state: 'done', input: fields };
    let current = boundedEntity(original, { kind: 'frame', id: 'f', turnId: 't', stepId: 's' }, 512);
    let pages = 0;
    while (current.contentRefs?.length) {
      const ref = current.contentRefs[0]!;
      const segment = readContentSegment(original, ref);
      if (segment.next !== undefined) expect(segment.next.offset).toBeGreaterThan(ref.offset);
      current = applyContentSegment(current, segment);
      expect(++pages).toBeLessThan(1000);
    }
    expect({ ...current, contentRefs: undefined }).toEqual(original);
  });

  it('advances an indivisible oversized object key and oversized path metadata', () => {
    const original = { output: { ['汉😀'.repeat(30_000)]: 'exact first middle last' } };
    let current = boundedEntity(original, { kind: 'task', id: 'large-key' });
    while (current.contentRefs?.length) {
      const ref = current.contentRefs[0]!;
      const segment = readContentSegment(original, ref);
      expect(segment.next === undefined || segment.next.offset > ref.offset).toBe(true);
      current = applyContentSegment(current, segment);
    }
    expect(current.output).toEqual(original.output);
  });
});


it('keeps media locators immediately requestable rather than sending a truncated src', async () => {
  const url = `https://example.test/image.png?signature=${'s'.repeat(5000)}`;
  const remote = { attachmentId: 'remote', mediaType: 'image/png', source: { kind: 'url' as const, url } };
  expect(boundedAttachment(remote, 'main', 512).source).toEqual(remote.source);
  expect(boundedEntity(remote, { kind: 'attachment', id: remote.attachmentId }, 512).source).toEqual(remote.source);
  const fixture = new URL('../../../apps/kiki-gui/fixtures/sent-images.scenario.mjs', import.meta.url).href;
  const { pictures } = await import(fixture);
  const bytes: Buffer = pictures[0].bytes;
  const inline = { attachmentId: 'inline-image', mediaType: 'image/png', source: { kind: 'url' as const, url: `data:image/png;base64,${bytes.toString('base64')}` } };
  const projected = boundedAttachment(inline, 'main', 512);
  expect(projected.source).toMatchObject({ kind: 'session_media', fileId: expect.stringMatching(/^inline:main:/u) });
  expect(projected.contentRefs?.some((ref) => ref.path[0] === 'source')).not.toBe(true);
  const file = (await inlineMediaFile(inline))!;
  const chunks: Uint8Array[] = [];
  for await (const chunk of file.stream()) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(bytes);
});

describe('inline current-agent working state', () => {
  const fields = ['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open'];
  const meta = { rev: 7, hash: 'notes-hash', writtenTurn: 12, writtenStep: 't12.3', coveredMessageId: '', windowEpoch: 1 };
  const notes = (character: string) => Object.fromEntries(fields.map((field, index) => [field, character.repeat([1500, 1500, 1500, 1500, 499, 499, 499, 3][index]!)]));
  const items = Array.from({ length: 14 }, (_, index) => ({ title: `Complete task ${index + 1}`, status: index === 0 ? 'in_progress' as const : 'pending' as const }));

  it.each(['字', '\u0000'])('inlines legal maximum notes and the complete checklist within a finite JSON byte budget (%j)', (character) => {
    const todo = { todoId: 'todo', items, notes: notes(character), notesMeta: meta };
    expect(Object.values(todo.notes).reduce((sum, value) => sum + value.length, 0)).toBe(7500);
    const snapshot = boundedTranscriptSnapshot({ items: [], tasks: [], attachments: [], prompts: [], interactions: [], todos: [todo], meta: {} }, 'main');
    expect(snapshot.todos).toHaveLength(1);
    expect(snapshot.todos[0]).toMatchObject(todo);
    expect(snapshot.todos[0]?.contentRefs).toBeUndefined();
    expect(snapshot.globalCoverage?.todos).toEqual({ returned: 1, total: 1, hasMore: false });
    expect(jsonBytes(snapshot.todos)).toBeLessThanOrEqual(64 * 1024);
    const projected = boundedEntity(todo, { kind: 'todo', id: 'todo' });
    expect(projected.notes).toEqual(todo.notes);
    expect(projected.items).toEqual(items);
    expect(projected.contentRefs).toBeUndefined();
    expect(boundedTranscriptPageSource(snapshot, 'main').todos[0]).toEqual(projected);
    expect(boundedTranscriptOps([{ op: 'todo.upsert', todo }], new AgentTranscript('main'))).toEqual([{ op: 'todo.upsert', todo: projected }]);
  });

  it('keeps legacy small-budget notes refs readable without widening unrelated collections', () => {
    const todo = { todoId: 'todo', items, notes: notes('字'), notesMeta: meta };
    let projected = boundedEntity(todo, { kind: 'todo', id: 'todo' }, 2048);
    expect(projected.contentRefs?.length).toBeGreaterThan(0);
    const snapshot = boundedTranscriptSnapshot({ items: [], tasks: [], attachments: [], prompts: [], interactions: [], todos: [projected], meta: {} }, 'main');
    expect(snapshot.todos[0]).toEqual(projected);
    expect(boundedTranscriptPageSource(snapshot, 'main').todos[0]).toEqual(projected);
    expect(boundedTranscriptOps([{ op: 'todo.upsert', todo: projected }], new AgentTranscript('main'))).toEqual([{ op: 'todo.upsert', todo: projected }]);
    while (projected.contentRefs?.length) projected = applyContentSegment(projected, readContentSegment(todo, projected.contentRefs[0]!));
    expect(projected.notes).toEqual(todo.notes);
    expect(projected.items).toEqual(todo.items);
    const generic = boundedEntity(todo, { kind: 'task', id: 'example-task' }, 2048);
    expect(generic.contentRefs?.length).toBeGreaterThan(0);
    expect(jsonBytes(generic)).toBeLessThanOrEqual(2048);
  });

  it('keeps out-of-contract notes bounded and recoverable instead of blindly inlining them', () => {
    const todo = { todoId: 'todo', items, notes: { goal: '字'.repeat(1501) }, notesMeta: meta };
    let projected = boundedEntity(todo, { kind: 'todo', id: 'todo' });
    expect(projected.contentRefs?.some((ref) => ref.path[0] === 'notes')).toBe(true);
    while (projected.contentRefs?.length) projected = applyContentSegment(projected, readContentSegment(todo, projected.contentRefs[0]!));
    expect(projected.notes).toEqual(todo.notes);
  });

  it('keeps legal notes inline when a much larger checklist still needs exact continuations', () => {
    const todo = { todoId: 'todo', items: Array.from({ length: 100 }, (_, index) => ({ title: `Task ${index}: ${'字'.repeat(1500)}`, status: 'pending' as const })), notes: notes('\u0000'), notesMeta: meta };
    let projected = boundedEntity(todo, { kind: 'todo', id: 'todo' });
    expect(projected.notes).toEqual(todo.notes);
    expect(projected.contentRefs?.some((ref) => ref.path[0] === 'notes')).not.toBe(true);
    expect(projected.contentRefs?.some((ref) => ref.path[0] === 'items')).toBe(true);
    expect(jsonBytes(projected)).toBeLessThanOrEqual(64 * 1024);
    while (projected.contentRefs?.length) projected = applyContentSegment(projected, readContentSegment(todo, projected.contentRefs[0]!));
    expect(projected.items).toEqual(todo.items);
    expect(projected.notes).toEqual(todo.notes);
  });
});
