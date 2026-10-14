import { describe, expect, it } from 'vitest';
import { ExternalTurnRecorder } from '@kiki/agent-core-v2/agent/execution/externalTurnRecorder';
import { IWireService } from '@kiki/agent-core-v2/wire/wire';
import {
  AgentTranscript,
  TranscriptFactReducer,
  TranscriptWireAdapter,
  type TranscriptEvent,
  type TranscriptOperation,
  type TranscriptWireRecord,
} from '@kiki/transcript';
import { SessionController } from '@kiki/session-core/session/sessionController';
import { createTestAgent } from '../../agent-core-v2/test/harness';

const SESSION_ID = 'session_vertical';
const outbound = '[Kiki memory]\nremember this\n\nwork';

function boundaryOf(frames: readonly { kind: string; role?: string }[]): number {
  const index = frames.findIndex((frame) => frame.kind !== 'text' || frame.role !== 'user');
  return index < 0 ? frames.length : index;
}

async function readJournal(wire: IWireService): Promise<TranscriptWireRecord[]> {
  const records: TranscriptWireRecord[] = [];
  for await (const record of wire.readJournal()) records.push(record as TranscriptWireRecord);
  return records;
}

describe('external boundary vertical', () => {
  it('projects a split known preamble through the real wire, adapter, controller, and checkpoint', async () => {
    const agent = createTestAgent();
    const controller = new SessionController({} as never, {} as never, SESSION_ID, {
      scheduler: { schedule(callback: () => void) { callback(); return 0; }, cancel() {} },
    });
    try {
      const wire = agent.get(IWireService);
      const before = (await readJournal(wire)).length;
      const recorder = new ExternalTurnRecorder(
        { id: 'main', accessor: { get: agent.get.bind(agent) } },
        4,
        SESSION_ID,
        { executorId: 'example-acp', protocol: 'acp-v1', model: 'model', resumeMode: 'new', profileDelivery: 'native', outboundPrompt: outbound },
      );
      await recorder.begin('work', { kind: 'user' }, [], 'prompt-1');
      await recorder.record({ type: 'message.delta', role: 'user', messageId: 'preamble', content: { type: 'text', text: '[Kiki mem' } });
      await recorder.record({ type: 'thought.delta', messageId: 'think-1', content: { type: 'text', text: 'planning' } });
      await recorder.record({ type: 'message.delta', role: 'user', messageId: 'preamble', content: { type: 'text', text: 'ory]\nremember this' } });
      await recorder.record({ type: 'tool.call', toolCallId: 'read-1', title: 'Read', status: 'pending' });
      await recorder.record({ type: 'message.delta', role: 'user', messageId: 'echo', content: { type: 'text', text: '[Kiki memory]\nremember this' } });
      await recorder.record({ type: 'thought.delta', messageId: 'think-2', content: { type: 'text', text: 'later' } });
      await recorder.record({ type: 'message.delta', role: 'user', messageId: 'echo', content: { type: 'text', text: ' TAILMARK' } });
      await recorder.record({ type: 'message.delta', role: 'user', messageId: 'after', content: { type: 'text', text: 'brand new after tool' } });
      await recorder.complete('end_turn');

      const records = (await readJournal(wire)).slice(before);
      const transcript = new AgentTranscript('main');
      const adapter = new TranscriptWireAdapter('main');
      const reducer = new TranscriptFactReducer(transcript);
      const ops: TranscriptOperation[] = [];
      for (const record of records) {
        const facts = adapter.add(record);
        reducer.apply(facts);
        for (const fact of facts) ops.push(...fact.operations);
      }
      const turn = transcript.getTurn('t4');
      const frames = turn?.steps[0]?.frames ?? [];
      expect(frames.map((frame) => frame.frameId)).toEqual([
        'preamble', 'echo', expect.any(String), expect.stringContaining('read-1'), expect.any(String), 'after',
      ]);
      expect(frames[0]).toMatchObject({
        text: '[Kiki memory]\nremember this',
        origin: { kind: 'injection', variant: 'memory', ownerPromptId: 'prompt-1' },
      });
      expect(frames[1]).toMatchObject({
        text: '[Kiki memory]\nremember this TAILMARK',
        origin: { kind: 'injection', variant: 'memory', ownerPromptId: 'prompt-1' },
      });
      expect(frames.find((frame) => frame.frameId === 'after')).toMatchObject({
        text: 'brand new after tool', origin: { kind: 'unknown' },
      });

      const restored = new TranscriptWireAdapter('main');
      restored.restore(JSON.parse(JSON.stringify(adapter.checkpoint())) as ReturnType<TranscriptWireAdapter['checkpoint']>);
      const stepId = turn?.steps[0]?.stepId;
      const next: TranscriptWireRecord = {
        type: 'context.append_message', time: 9,
        message: { id: 'next-boundary', role: 'user', content: [{ type: 'text', text: '[Kiki memory]\nremember this' }], origin: { kind: 'injection', variant: 'memory', ownerPromptId: 'prompt-1' } },
        delivery: { messageId: 'next-boundary', turnId: 4, stepId, step: 1, origin: 'injection', placement: 'safety_boundary' },
      };
      const liveOp = adapter.add(next).flatMap((fact) => fact.operations).find((op) => op.op === 'frame.upsert' && op.frame.frameId === 'next-boundary');
      const restoredOp = restored.add(next).flatMap((fact) => fact.operations).find((op) => op.op === 'frame.upsert' && op.frame.frameId === 'next-boundary');
      expect(liveOp?.op).toBe('frame.upsert');
      expect(restoredOp?.op).toBe('frame.upsert');
      if (liveOp?.op !== 'frame.upsert' || restoredOp?.op !== 'frame.upsert') return;
      expect(restoredOp.frameIndex).toBe(liveOp.frameIndex);
      expect(restoredOp.frameIndex).toBe(boundaryOf(frames));

      const reset: TranscriptEvent = {
        type: 'transcript.reset', session_id: SESSION_ID, agent_id: 'main', grade: 'delta',
        snapshot: { items: [], tasks: [], attachments: [], prompts: [], interactions: [], todos: [], meta: {}, hasMoreOlder: false },
        coverage: { kind: 'full', hasMoreOlder: false },
        cursor: { seq: 1, epoch: 'epoch-vertical' },
      };
      const batch: TranscriptEvent = {
        type: 'transcript.ops', session_id: SESSION_ID, agent_id: 'main', ops,
        cursor: { seq: 2, epoch: 'epoch-vertical' }, through_seq: 2,
      };
      controller.handleTranscript(reset);
      controller.handleTranscript(batch);
      const blocks = controller.getState().blocks;
      const preamble = blocks.find((block) => block.kind === 'system' && block.text === '[Kiki memory]\nremember this');
      const echo = blocks.find((block) => block.kind === 'system' && block.text.includes('TAILMARK'));
      const after = blocks.find((block) => block.kind === 'user' && block.text === 'brand new after tool');
      const tool = blocks.find((block) => block.kind === 'tool');
      const thinking = blocks.find((block) => block.kind === 'thinking');
      expect(preamble).toMatchObject({ kind: 'system', ownerPromptId: 'prompt-1' });
      expect(echo).toMatchObject({ kind: 'system', ownerPromptId: 'prompt-1' });
      expect(after).toMatchObject({ kind: 'user', sourceOrigin: { kind: 'unknown' } });
      expect(blocks.indexOf(preamble!)).toBeGreaterThanOrEqual(0);
      expect(blocks.indexOf(echo!)).toBeGreaterThan(blocks.indexOf(preamble!));
      expect(blocks.indexOf(thinking!)).toBeGreaterThan(blocks.indexOf(echo!));
      expect(blocks.indexOf(tool!)).toBeGreaterThan(blocks.indexOf(thinking!));
      expect(blocks.indexOf(after!)).toBeGreaterThan(blocks.indexOf(tool!));
      expect(blocks.some((block) => block.kind === 'user' && block.text.includes('[Kiki memory]'))).toBe(false);
    } finally {
      controller.close();
      await agent.dispose();
    }
  }, 60_000);
});
