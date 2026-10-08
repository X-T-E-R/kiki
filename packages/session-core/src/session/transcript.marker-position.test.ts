import { describe, expect, it } from 'vitest';
import { AgentTranscript, TranscriptFactReducer, TranscriptWireAdapter, type TranscriptWireRecord } from '@kiki/transcript';
import { createViewState, projectAgentTranscriptView } from './transcript';
import { foldHistory, groupBlocks } from './grouping';
import { agentTranscriptToBlocks } from './transcript/project';
import type { AgentTranscriptProjectionSource } from './transcript/project';

const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
const turn = (ordinal: number, start: number, steps: readonly [number, string][]) => ({
  kind: 'turn' as const, turnId: `t${ordinal}`, ordinal, state: 'completed' as const,
  startedAt: at(start), origin: { kind: 'user' as const }, prompt: `turn ${ordinal}`,
  steps: steps.map(([time, text], index) => ({ kind: 'step' as const, stepId: `t${ordinal}.${index}`, turnId: `t${ordinal}`,
    ordinal: index, state: 'completed' as const, startedAt: at(time), endedAt: at(time + 1),
    frames: [{ kind: 'text' as const, frameId: `f${ordinal}.${index}`, role: 'assistant' as const, text }],
  })),
});
const marker = (id: string, second: number, name = 'compaction') => ({ kind: 'marker' as const,
  markerId: id, marker: name, at: at(second), payload: { type: 'context.apply_compaction', summary: id, strategy: 'relay' },
});
const project = (items: AgentTranscriptProjectionSource['items']) => agentTranscriptToBlocks({ agent_id: 'main', items });

describe('source-position timeline markers', () => {
  it('puts renewal inside its long-running turn, between the actual step boundaries, not after the whole turn', () => {
    const blocks = project([turn(0, 0, [[1, 'before'], [5, 'after']]), marker('renew', 4), turn(1, 9, [[10, 'next']])]);
    expect(blocks.map((block) => block.id)).toEqual(['user-agent-turn-t0-prompt', 'agent-frame-f0.0',
      'agent-marker-renew', 'agent-frame-f0.1', 'user-agent-turn-t1-prompt', 'agent-frame-f1.0']);
  });
  it('places late backfilled model/goal/skill markers by source time without changing conversation order', () => {
    const blocks = project([turn(0, 0, [[1, 'first']]), turn(1, 10, [[11, 'last']]),
      marker('model', 3, 'goal'), marker('skill', 4, 'skill')]);
    expect(blocks.map((block) => block.id)).toEqual(['user-agent-turn-t0-prompt', 'agent-frame-f0.0',
      'agent-marker-model', 'agent-marker-skill', 'user-agent-turn-t1-prompt', 'agent-frame-f1.0']);
  });
  it('keeps a delivery marker at its real turn when its clock ties a frame', () => {
    const blocks = project([turn(0, 0, [[3, 'first']]), turn(1, 10, [[11, 'last']]), {
      kind: 'marker', markerId: 'delivery', marker: 'message.delivery', at: at(3),
      payload: { messageId: 'sent-message', text: 'sent text', turnId: 't0', origin: { kind: 'user' } },
    }]);
    expect(blocks.map((block) => block.id)).toEqual(['user-agent-turn-t0-prompt', 'agent-frame-f0.0',
      'user-sent-message', 'user-agent-turn-t1-prompt', 'agent-frame-f1.0']);
    expect(blocks[2]).toMatchObject({ turnId: 't0', userMessageId: 'sent-message' });
  });
  it('does not attach an old page-global marker to the tail until its owning window is loaded', () => {
    expect(project([turn(10, 10, [[11, 'tail']]), marker('old', 4)]).map((block) => block.id))
      .toEqual(['user-agent-turn-t10-prompt', 'agent-frame-f10.0']);
    const full = project([turn(0, 0, [[1, 'before'], [5, 'after']]), turn(10, 10, [[11, 'tail']]), marker('old', 4)]);
    expect(full.map((block) => block.id).indexOf('agent-marker-old')).toBe(2);
    expect(project([turn(0, 0, [[1, 'before'], [5, 'after']]), marker('old', 4), turn(10, 10, [[11, 'tail']])]))
      .toEqual(full);
  });
});

it('restores each absorbed prompt from a merged canonical delivery, with media, instead of retaining tail echoes', () => {
  const prompts = ['first', 'second', 'third'].map((id, index) => ({ promptId: id, userMessageId: id,
    status: 'completed' as const, createdAt: at(1), steeredAt: at(2), finishedAt: at(2),
    content: [{ type: 'text' as const, text: `message ${index}` },
      ...(index === 1 ? [{ type: 'image' as const, source: { kind: 'url' as const, url: 'https://example.test/photo.png' } }] : [])],
  }));
  const source: AgentTranscriptProjectionSource = { agent_id: 'main', prompts,
    items: [{ kind: 'turn', turnId: 't0', ordinal: 0, state: 'running', origin: { kind: 'user' }, startedAt: at(0),
      steps: [{ kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'running', startedAt: at(3),
        frames: [{ kind: 'text', frameId: 'first', role: 'user', text: 'message 0message 1message 2',
          origin: { kind: 'user' }, part: { partId: 'first', messageId: 'first', revision: 0, provenance: { source: 'engine' } } }],
      }],
    }],
  };
  const blocks = agentTranscriptToBlocks(source);
  expect(blocks.map((block) => block.id)).toEqual(['user-first', 'user-second', 'user-third']);
  expect(blocks[1]).toMatchObject({ text: 'message 1', turnId: 't0', media: [{ kind: 'image', url: 'https://example.test/photo.png' }] });
  expect(agentTranscriptToBlocks(source, blocks)).toEqual(blocks);
});


describe('prompt-owned context reading order', () => {
  const message = (id: string, text: string, origin: Record<string, unknown>) => ({
    id, role: 'user', origin, content: [{ type: 'text', text }],
  });
  const records: TranscriptWireRecord[] = [
    { type: 'turn.prompt', turnId: 0, promptId: 'previous', origin: { kind: 'user' }, input: [{ type: 'text', text: 'previous request' }], time: 1_000 },
    { type: 'turn.ended', turnId: 0, reason: 'completed', time: 2_000 },
    { type: 'context.append_message', message: message('unowned', '<system-reminder>idle notification</system-reminder>', { kind: 'injection', variant: 'goal_cancelled' }), time: 3_000 },
    { type: 'context.append_message', message: message('caption', '<system-reminder>image caption</system-reminder>', { kind: 'injection', variant: 'image_compression', ownerPromptId: 'current' }), time: 4_000 },
    { type: 'turn.prompt', turnId: 1, promptId: 'current', origin: { kind: 'user' }, managed: true, time: 5_000 },
    { type: 'context.append_message', message: message('snapshot', '<system-reminder>Host runtime snapshot rev 1. Full snapshot.</system-reminder>', { kind: 'injection', variant: 'runtime_snapshot' }), delivery: { messageId: 'snapshot', turnId: 1, origin: 'injection' }, time: 5_100 },
    { type: 'context.append_message', message: message('context', 'prompt-specific context', { kind: 'injection', variant: 'hook_rule/example', ownerPromptId: 'current' }), delivery: { messageId: 'context', turnId: 1, origin: 'injection' }, time: 5_200 },
    { type: 'context.append_message', message: message('current', 'current request quotes <system-reminder>literally</system-reminder>', { kind: 'user' }), delivery: { messageId: 'current', turnId: 1, origin: 'user' }, time: 5_300 },
    { type: 'turn.ended', turnId: 1, reason: 'completed', time: 6_000 },
  ];
  const expected = ['user-previous', 'reminder-unowned-0', 'user-current', 'reminder-caption-0', 'reminder-snapshot-0', 'system-context'];

  it('starts at the real user after pre-materialization context, live and on cold replay', () => {
    const transcript = new AgentTranscript('main');
    const adapter = new TranscriptWireAdapter('main', { turn: (id) => transcript.getTurn(id) });
    const reducer = new TranscriptFactReducer(transcript);
    let live = createViewState('session_test');
    for (const record of records) {
      reducer.apply(adapter.add(record));
      live = projectAgentTranscriptView(live, 'main', transcript.snapshot());
      if (record.type === 'context.append_message' && (record['message'] as { id: string }).id === 'current') {
        expect(live.blocks.map((block) => block.id)).toEqual(expected);
      }
    }
    const coldTranscript = new AgentTranscript('main');
    const coldAdapter = new TranscriptWireAdapter('main', { turn: (id) => coldTranscript.getTurn(id) });
    const coldReducer = new TranscriptFactReducer(coldTranscript);
    for (const record of records) coldReducer.apply(coldAdapter.add(record));
    const cold = projectAgentTranscriptView(createViewState('session_test'), 'main', coldTranscript.snapshot());
    expect(live.blocks.map((block) => block.id)).toEqual(expected);
    expect(cold.blocks).toEqual(live.blocks);
    expect(cold.blocks.find((block) => block.id === 'user-current')).toMatchObject({
      text: 'current request quotes <system-reminder>literally</system-reminder>', userMessageId: 'current', turnId: 't1',
    });
    expect(cold.blocks.find((block) => block.id === 'reminder-caption-0')).toMatchObject({ text: 'image caption' });
    expect(cold.blocks.find((block) => block.id === 'system-context')).toMatchObject({ text: 'prompt-specific context' });
    const nodes = foldHistory(groupBlocks(cold.blocks), 't1');
    const flattened = nodes.flatMap((node) => node.kind === 'history-fold' ? node.members.map((member) => member.id) : [node.id]);
    expect(flattened).toEqual(expected);

    const snapshot = coldTranscript.snapshot();
    const tail = { ...snapshot, items: snapshot.items.filter((item) => item.kind !== 'turn' || item.turnId === 't1') };
    const tailBlocks = agentTranscriptToBlocks({ agent_id: 'main', ...tail });
    expect(tailBlocks.map((block) => block.id)).toContain('reminder-caption-0');
    expect(tailBlocks.findIndex((block) => block.id === 'user-current')).toBeLessThan(tailBlocks.findIndex((block) => block.id === 'reminder-caption-0'));
    expect(agentTranscriptToBlocks({ agent_id: 'main', ...snapshot }, tailBlocks)).toEqual(cold.blocks);
    const delayed = { ...snapshot, items: snapshot.items.filter((item) => item.kind !== 'marker') };
    const withoutMarkers = agentTranscriptToBlocks({ agent_id: 'main', ...delayed });
    expect(agentTranscriptToBlocks({ agent_id: 'main', ...snapshot }, withoutMarkers)).toEqual(cold.blocks);
  });

  it('keeps owned steer context after its exact message, not the first user in the turn', () => {
    const frame = (id: string, text: string, origin: Record<string, unknown>) => ({
      kind: 'text' as const, frameId: id, role: 'user' as const, text, origin,
      part: { partId: id, messageId: id, revision: 0, provenance: { source: 'engine' as const } },
    });
    const blocks = project([{ ...turn(0, 0, [[1, 'reply before steer']]), state: 'running', steps: [
      turn(0, 0, [[1, 'reply before steer']]).steps[0]!,
      { kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'running', startedAt: at(3), frames: [
        frame('steer-context', '<system-reminder>steer attachment</system-reminder>', { kind: 'injection', ownerPromptId: 'steer' }),
        frame('steer', 'same text', { kind: 'user' }),
        frame('repeat-context', 'repeat attachment', { kind: 'injection', ownerPromptId: 'repeat' }),
        frame('repeat', 'same text', { kind: 'user' }),
      ] },
    ] }]);
    expect(blocks.map((block) => block.id)).toEqual(['user-agent-turn-t0-prompt', 'agent-frame-f0.0',
      'user-steer', 'reminder-steer-context-0', 'user-repeat', 'system-repeat-context']);
  });

  it('anchors the running prompt body to its known turn even while the header has no prompt text', () => {
    const source: AgentTranscriptProjectionSource = { agent_id: 'main',
      prompts: [{ promptId: 'request', userMessageId: 'message', status: 'running', createdAt: at(3),
        content: [{ type: 'text', text: 'Ask me the fixture questions.' }] }],
      items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', startedAt: at(2),
        origin: { kind: 'user', payload: { promptId: 'request', userMessageId: 'message' } },
        steps: [{ kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running', startedAt: at(2), frames: [
          { kind: 'text', frameId: 'snapshot', role: 'user', text: '<system-reminder>Host runtime snapshot rev 1.</system-reminder>', origin: { kind: 'injection', variant: 'runtime_snapshot' } },
          { kind: 'tool', frameId: 'ask', toolCallId: 'ask', name: 'AskUserQuestion', state: 'running', startedAt: at(2) },
        ] }],
      }],
    };
    const blocks = agentTranscriptToBlocks(source);
    expect(blocks.map((block) => block.id)).toEqual(['user-message', 'reminder-agent-frame-snapshot-0', 'tool-ask']);
    expect(blocks[0]).toMatchObject({ turnId: 't1', promptId: 'request', userMessageId: 'message' });
    expect(agentTranscriptToBlocks(source, blocks)).toEqual(blocks);
    const hydrated: AgentTranscriptProjectionSource = { ...source,
      items: source.items.map((item) => item.kind !== 'turn' ? item : { ...item, prompt: 'Ask me the fixture questions.' }),
    };
    expect(agentTranscriptToBlocks(hydrated, blocks).map((block) => block.id)).toEqual(blocks.map((block) => block.id));
    const queued: AgentTranscriptProjectionSource = { ...source,
      prompts: source.prompts!.map((prompt) => ({ ...prompt, status: 'queued' })),
    };
    expect(agentTranscriptToBlocks(queued)[0]?.id).toBe('reminder-agent-frame-snapshot-0');
  });

  it('leaves a system-triggered turn without a user and prior unowned context in place', () => {
    const blocks = project([turn(0, 0, [[1, 'answer']]), {
      ...turn(1, 3, [[4, 'system answer']]), origin: { kind: 'other', payload: { kind: 'system_trigger', name: 'goal_continuation' } }, prompt: 'continue goal',
    }, { kind: 'marker', markerId: 'idle', marker: 'message.delivery', at: at(2),
      payload: { messageId: 'idle', text: '<system-reminder>unowned</system-reminder>', origin: { kind: 'injection' } },
    }]);
    expect(blocks.map((block) => block.id)).toEqual(['user-agent-turn-t0-prompt', 'agent-frame-f0.0',
      'reminder-idle-0', 'system-agent-turn-t1-prompt', 'agent-frame-f1.0']);
  });
});
