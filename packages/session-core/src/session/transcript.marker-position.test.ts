import { describe, expect, it } from 'vitest';
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
