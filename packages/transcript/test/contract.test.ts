import { describe, expect, it } from 'vitest';
import { applyContentSegment, contentRefSchema, contentSegmentSchema, jsonBytes, jsonTextPrefix, sameContentRef, type ContentRef } from '#/contract/content';
import { AgentTranscript } from '#/store/agentTranscript';

import {
  agentTranscriptSnapshotSchema,
  transcriptDetailQuerySchema,
  transcriptDetailResponseSchema,
  transcriptOperationSchema,
  transcriptProvenanceSchema,
} from '#/contract/schema';

describe('windowed transcript global contract', () => {
  it('preserves absolute wire spans and rejects empty or reversed coordinates', () => {
    const provenance = { source: 'legacy-wire', recordSpan: { startByteOffset: 9_000_000, endByteOffset: 9_000_100 } };
    expect(transcriptProvenanceSchema.parse(provenance)).toEqual(provenance);
    for (const endByteOffset of [8_999_999, 9_000_000]) expect(transcriptProvenanceSchema.safeParse({
      ...provenance, recordSpan: { ...provenance.recordSpan, endByteOffset },
    }).success).toBe(false);
  });

  it('accepts legacy arrays plus optional coverage and references', () => {
    const snapshot = agentTranscriptSnapshotSchema.parse({
      items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
      taskRefs: [{ kind: 'task', taskId: 'task-1' }],
      attachmentRefs: [{ kind: 'attachment', attachmentId: 'attachment-1' }],
      promptRefs: [{ kind: 'prompt', promptId: 'prompt-1' }],
      globalCoverage: {
        version: 1,
        tasks: { returned: 1, total: 2, hasMore: true },
        attachments: { returned: 0, total: 1, hasMore: true },
        prompts: { returned: 1, total: 1, hasMore: false },
      },
    });
    expect(snapshot.globalCoverage?.tasks.hasMore).toBe(true);
    expect(snapshot.taskRefs).toHaveLength(1);
  });

  it('validates detail endpoint references and discriminated responses', () => {
    expect(transcriptDetailQuerySchema.safeParse({ agent_id: 'main', kind: 'task', id: 'task-1' }).success).toBe(true);
    expect(transcriptDetailQuerySchema.safeParse({ agent_id: '../main', kind: 'task', id: 'task-1' }).success).toBe(false);
    expect(transcriptDetailResponseSchema.parse({
      session_id: 's1', agent_id: 'main', kind: 'task',
      task: { taskId: 'task-1', kind: 'subagent', state: 'completed', detached: false, outputTail: 'done' },
    })).toMatchObject({ kind: 'task', task: { taskId: 'task-1' } });
  });
});


describe('backward canonical structure contract', () => {
  const ref: ContentRef = { source: { kind: 'turn', id: 'turn' }, revision: 'fixed-structure', path: ['steps'],
    kind: 'array', direction: 'backward', offset: 2, total: 4 };
  const steps = Array.from({ length: 5 }, (_, ordinal) => ({ stepId: `step-${ordinal}`, ordinal, frames: [] }));

  it('retains direction and the page start on the wire without changing legacy refs', () => {
    expect(contentRefSchema.parse(ref)).toEqual(ref);
    const segment = { ref, start: 0, value: steps.slice(0, 2), contentRefs: [] };
    expect(contentSegmentSchema.parse(segment)).toEqual(segment);
    const frame = { op: 'frame.upsert', turnId: 'turn', stepId: 'step-3', frameIndex: 12,
      frame: { kind: 'text', frameId: 'frame-12', role: 'assistant', text: 'latest' } };
    expect(transcriptOperationSchema.parse(frame)).toEqual(frame);
    expect(sameContentRef(ref, { ...ref, direction: undefined })).toBe(false);
    expect(sameContentRef({ ...ref, direction: undefined }, { ...ref, direction: 'forward' })).toBe(true);
  });

  it('prepends an older page exactly once and keeps the live suffix outside the captured watermark', () => {
    const entity = { steps: steps.slice(2), contentRefs: [ref] };
    const segment = { ref, start: 0, value: steps.slice(0, 2), contentRefs: [] };
    const complete = applyContentSegment(entity, segment);
    expect(complete.steps).toEqual(steps);
    expect(complete.contentRefs).toEqual([]);
    expect(applyContentSegment(complete, segment)).toBe(complete);
    expect(entity.steps).toEqual(steps.slice(2));
  });

  it('rejects a reverse page whose start, count or continuation does not reach the inline window', () => {
    const entity = { steps: steps.slice(2), contentRefs: [ref] };
    expect(() => applyContentSegment(entity, { ref, value: steps.slice(0, 2), contentRefs: [] })).toThrow('offset mismatch');
    expect(() => applyContentSegment(entity, { ref, start: 1, value: steps.slice(0, 2), contentRefs: [] })).toThrow('offset mismatch');
    expect(() => applyContentSegment(entity, { ref, start: 1, value: steps.slice(1, 2), contentRefs: [] })).toThrow('offset mismatch');
  });
});


it('does not insert an omitted older step update into a compact suffix, while current and new steps keep streaming', () => {
  const ref: ContentRef = { source: { kind: 'turn', id: 'turn' }, revision: 'fixed-steps', path: ['steps'], kind: 'array',
    direction: 'backward', offset: 99, total: 107 };
  const store = new AgentTranscript('child');
  const step = { kind: 'step' as const, stepId: 'turn.106', turnId: 'turn', ordinal: 106, state: 'running' as const, frames: [] };
  store.apply([{ op: 'reset', agentId: 'child', snapshot: { items: [{ kind: 'turn', turnId: 'turn', ordinal: 0,
    state: 'running', origin: { kind: 'user' }, steps: [step], contentRefs: [ref] }],
    tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} } }]);
  store.apply([{ op: 'step.upsert', turnId: 'turn', step: { ...step, stepId: 'turn.0', ordinal: 0 } },
    { op: 'frame.upsert', turnId: 'turn', stepId: 'turn.0', frameIndex: 0,
      frame: { kind: 'text', frameId: 'old', role: 'assistant', text: 'updated old output' } }]);
  expect(store.getTurn('turn')?.steps.map((entry) => entry.ordinal)).toEqual([106]);
  store.apply([{ op: 'frame.upsert', turnId: 'turn', stepId: 'turn.106', frameIndex: 0,
    frame: { kind: 'text', frameId: 'latest', role: 'assistant', text: 'current output' } },
    { op: 'step.upsert', turnId: 'turn', step: { ...step, stepId: 'turn.107', ordinal: 107 } },
    { op: 'frame.upsert', turnId: 'turn', stepId: 'turn.107', frameIndex: 0,
      frame: { kind: 'text', frameId: 'new', role: 'assistant', text: 'new output' } }]);
  expect(store.getTurn('turn')?.steps.map((entry) => entry.ordinal)).toEqual([106, 107]);
  expect(store.getTurn('turn')?.steps.at(-1)?.frames.at(-1)).toMatchObject({ text: 'new output' });
});


it('uses actual suffix offsets for indexed appends when the byte budget shrinks the window below eight frames', () => {
  const ref: ContentRef = { source: { kind: 'turn', id: 'turn' }, revision: 'small-window', path: ['steps', 0, 'frames'],
    kind: 'array', direction: 'backward', offset: 39, total: 40 };
  const store = new AgentTranscript('child');
  store.apply([{ op: 'reset', agentId: 'child', snapshot: { items: [{ kind: 'turn', turnId: 'turn', ordinal: 0,
    state: 'running', origin: { kind: 'user' }, steps: [{ kind: 'step', stepId: 'step', turnId: 'turn', ordinal: 0,
      state: 'running', frames: [{ kind: 'text', frameId: 'frame-39', role: 'assistant', text: 'abc' }] }], contentRefs: [ref] }],
    tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {} } }]);
  const append = { op: 'append' as const, target: { type: 'frame' as const, turnId: 'turn', stepId: 'step', frameId: 'frame-33' },
    stepIndex: 0, frameIndex: 33, offset: 0, text: 'older update' };
  expect(transcriptOperationSchema.parse(append)).toEqual(append);
  expect(store.apply([append]).gap).toBeUndefined();
  expect(store.getTurn('turn')?.steps[0]?.frames).toHaveLength(1);
  expect(store.apply([{ ...append, target: { ...append.target, frameId: 'frame-39' }, frameIndex: 39, offset: 3, text: 'd' }]).gap).toBeUndefined();
  expect(store.getTurn('turn')?.steps[0]?.frames[0]).toMatchObject({ text: 'abcd' });
  expect(store.apply([{ ...append, target: { ...append.target, frameId: 'frame-40' }, frameIndex: 40 }]).gap).toBeDefined();
});

describe('JSON byte budgets', () => {
  const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  it('counts escaped UTF-8 JSON bytes exactly', () => {
    for (const value of ['plain', 'quote " slash \\ line\n', '\u0001', 'é中😀', '\ud800x', '\udc00', { a: ['中', 1, null] }, 42]) {
      expect(jsonBytes(value)).toBe(encoded(value));
    }
  });

  it('selects the longest JSON text prefix within the budget without splitting a pair', () => {
    expect(jsonTextPrefix('Z 😀😀', 0, 11)).toBe('Z 😀');
    expect(jsonTextPrefix('ab😀', 0, 7)).toBe('ab');
    expect(jsonTextPrefix('a"b', 1, 5)).toBe('"b');
    const text = '中文 "q" 😀\n'.repeat(50);
    for (let max = 2; max < 80; max += 1) {
      const prefix = jsonTextPrefix(text, 3, max);
      expect(encoded(prefix)).toBeLessThanOrEqual(max);
      expect(text.startsWith(prefix, 3)).toBe(true);
      const next = text.codePointAt(3 + prefix.length)!;
      expect(encoded(prefix + String.fromCodePoint(next))).toBeGreaterThan(max);
    }
  });
});
