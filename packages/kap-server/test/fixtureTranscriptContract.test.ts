import {
  agentTranscriptSnapshotSchema,
  transcriptEventSchema,
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
} from '@kiki/transcript';
import { describe, expect, it } from 'vitest';

import { wsEventEnvelopeSchema } from '../src/protocol/ws-control';

interface FixtureBatch {
  seq: number;
  ops: unknown[];
}

interface FixtureProjector {
  ingestFrame(frame: unknown, extras?: unknown): FixtureBatch[];
  opsEvent(agentId: string, batch: FixtureBatch): unknown;
  resetEvent(agentId: string, grade?: 'turn' | 'block' | 'delta'): unknown;
}

interface FixtureTranscriptModule {
  TranscriptProjector: new (sessionId: string, seed?: unknown, epoch?: string) => FixtureProjector;
  seedMessages(
    projector: FixtureProjector,
    messages: unknown[],
    options?: { older?: unknown[]; hasMore?: boolean },
  ): void;
  transcriptEnvelope(sessionId: string, payload: unknown, seq: number, epoch: string): unknown;
}

const fixture = (await import(
  new URL('../../../apps/kiki-gui/scripts/fixture-transcript.mjs', import.meta.url).href
)) as FixtureTranscriptModule;
const transcriptEnvelopeSchema = wsEventEnvelopeSchema(transcriptEventSchema);

const olderMessages = [
  {
    id: 'um-older',
    role: 'user',
    content: [{ type: 'text', text: 'older prompt' }],
    created_at: '2026-01-01T00:00:00.000Z',
  },
];

const windowMessages = [
  {
    id: 'um-current',
    role: 'user',
    prompt_id: 'prompt-current',
    content: [{ type: 'text', text: 'current prompt' }],
    created_at: '2026-01-01T00:00:01.000Z',
  },
  {
    id: 'am-current',
    role: 'assistant',
    content: [
      { type: 'text', text: 'running' },
      {
        type: 'tool_use',
        tool_call_id: 'call_1',
        tool_name: 'Bash',
        input: { command: 'ls' },
      },
    ],
    created_at: '2026-01-01T00:00:02.000Z',
  },
  {
    id: 'tm-current',
    role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: 'call_1', output: 'file.txt' }],
    created_at: '2026-01-01T00:00:03.000Z',
  },
];

describe('GUI visual-proof transcript fixture contract', () => {
  it('matches the kap-server transcript payload and envelope schemas', () => {
    const projector = new fixture.TranscriptProjector('session_fixture_contract');
    fixture.seedMessages(projector, windowMessages, { older: olderMessages, hasMore: true });

    const resetCandidate = projector.resetEvent('main', 'delta');
    const reset = transcriptResetEventSchema.parse(resetCandidate);
    const snapshot = agentTranscriptSnapshotSchema.parse(reset.snapshot);
    const turn = snapshot.items.find((item) => item.kind === 'turn');
    expect(turn).toMatchObject({ state: 'completed', prompt: 'current prompt' });
    expect(turn?.kind === 'turn' ? turn.steps[0]?.frames : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'text', text: 'running' }),
        expect.objectContaining({
          kind: 'tool',
          toolCallId: 'call_1',
          state: 'done',
          output: 'file.txt',
        }),
      ]),
    );
    expect(snapshot.hasMoreOlder).toBe(true);
    expect(reset.coverage).toEqual({ kind: 'tail', hasMoreOlder: true });

    const batches = projector.ingestFrame(
      {
        type: 'turn.started',
        payload: { turnId: 3, origin: { kind: 'user' }, prompt: 'next prompt' },
      },
      {
        promptId: 'prompt-next',
        userMessageId: 'um-next',
        at: '2026-01-01T00:00:04.000Z',
      },
    );
    expect(batches).toHaveLength(1);
    const ops = transcriptOpsEventSchema.parse(projector.opsEvent('main', batches[0]!));
    expect(ops.cursor.seq).toBe(ops.through_seq);
    const opNames = ops.ops.map((op) => op.op);
    expect(opNames).toEqual(
      expect.arrayContaining(['turn.upsert', 'step.upsert', 'meta.merge', 'prompt.upsert']),
    );
    expect(opNames.indexOf('turn.upsert')).toBeLessThan(opNames.indexOf('step.upsert'));

    const sessionWatermark = 41;
    const sessionEpoch = 'ep_session_durable_1';
    const resetEnvelope = transcriptEnvelopeSchema.parse(
      fixture.transcriptEnvelope(
        'session_fixture_contract',
        resetCandidate,
        sessionWatermark,
        sessionEpoch,
      ),
    );
    const opsEnvelope = transcriptEnvelopeSchema.parse(
      fixture.transcriptEnvelope('session_fixture_contract', ops, sessionWatermark, sessionEpoch),
    );
    expect(resetEnvelope).toMatchObject({
      type: 'transcript.reset',
      seq: sessionWatermark,
      epoch: sessionEpoch,
      volatile: true,
      session_id: 'session_fixture_contract',
      payload: {
        ...transcriptResetEventSchema.parse(resetCandidate),
        cursor: reset.cursor,
      },
    });
    expect(resetEnvelope.seq).not.toBe(reset.cursor.seq);
    expect(opsEnvelope).toMatchObject({
      type: 'transcript.ops',
      seq: sessionWatermark,
      epoch: sessionEpoch,
      volatile: true,
      session_id: 'session_fixture_contract',
      payload: { ...ops, cursor: ops.cursor },
    });
    expect(opsEnvelope.seq).not.toBe(ops.cursor.seq);
  });
});
