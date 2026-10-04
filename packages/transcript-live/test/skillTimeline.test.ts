import { describe, expect, it } from 'vitest';
import { AgentTranscript, TranscriptFactReducer, TranscriptWireAdapter } from '@kiki/transcript';
import { agentTranscriptToBlocks, foldHistory, groupBlocks } from '@kiki/session-core/session';
import { AgentTranscriptLiveAdapter, type LiveAdapterBusEvent } from '../src/liveAdapter';

const AT = '2026-01-01T00:00:00.000Z';

function skillTimeline(names: readonly string[], withLiveEvents: boolean) {
  const transcript = new AgentTranscript('example-agent');
  const wire = new TranscriptWireAdapter('example-agent');
  const reducer = new TranscriptFactReducer(transcript);
  const live = new AgentTranscriptLiveAdapter('example-agent');
  const apply = (record: Parameters<typeof wire.add>[0]) => reducer.apply(wire.add(record));
  apply({ type: 'turn.prompt', turnId: 0, promptId: 'prompt', input: [{ type: 'text', text: 'Review the code' }], origin: { kind: 'user' }, time: 0 });
  transcript.apply([
    { op: 'step.upsert', turnId: 't0', step: { kind: 'step', turnId: 't0', stepId: 'before', ordinal: 1, state: 'completed', startedAt: AT } },
    { op: 'frame.upsert', turnId: 't0', stepId: 'before', frame: { kind: 'text', frameId: 'before', role: 'assistant', text: 'Before activation' } },
  ]);
  for (const name of names) {
    const origin = { kind: 'skill_activation', activationId: `activation-${name}`, skillName: name, trigger: 'model-tool' };
    if (withLiveEvents) transcript.apply(live.map({ type: 'skill.activated', ...origin } as unknown as LiveAdapterBusEvent));
    const content = [{ type: 'text', text: `Skill loaded for this request.\n\n<skill-loaded name="${name}">Instructions for ${name}</skill-loaded>` }];
    apply({ type: 'turn.steer', turnId: 0, promptId: `message-${name}`, input: content, origin, managed: true, time: 1 });
    apply({
      type: 'context.append_message', time: 1,
      message: { role: 'user', id: `message-${name}`, origin, content },
      delivery: { deliveryId: `delivery-${name}`, messageId: `message-${name}`, turnId: 0, stepId: 'after', step: 2, deliveredAt: AT, origin: 'user' },
    });
  }
  transcript.apply([{ op: 'frame.upsert', turnId: 't0', stepId: 'after', frame: { kind: 'text', frameId: 'after', role: 'assistant', text: 'After activation' } }]);
  return { transcript, blocks: agentTranscriptToBlocks({ agent_id: 'example-agent', items: transcript.getItems() }) };
}

describe('skill activation timeline', () => {
  it('renders one original user request and one skill document through opening and delivered wire facts', () => {
    const transcript = new AgentTranscript('main');
    const wire = new TranscriptWireAdapter('main');
    const reducer = new TranscriptFactReducer(transcript);
    const userInput = '/skill:review --fix\nKeep this second line.';
    const origin = { kind: 'skill_activation', activationId: 'slash-review', skillName: 'review', skillArgs: '--fix\nKeep this second line.', trigger: 'user-slash', userInput };
    const input = [{ type: 'text', text: 'User activated the skill "review".\n\n<skill-loaded name="review">\n# Review instructions\n</skill-loaded>' }];
    reducer.apply(wire.add({ type: 'turn.prompt', turnId: 0, promptId: 'slash-prompt', input, origin, time: 0 }));
    reducer.apply(wire.add({ type: 'context.append_message', time: 1, message: { id: 'slash-prompt', role: 'user', content: input, origin },
      delivery: { deliveryId: 'slash-delivery', messageId: 'slash-prompt', turnId: 0, stepId: 'slash-step', step: 1, deliveredAt: AT, origin: 'user' } }));
    const blocks = agentTranscriptToBlocks({ agent_id: 'main', items: transcript.getItems() });
    expect(blocks.map(block => block.kind)).toEqual(['user', 'skill']);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: userInput });
    expect(blocks[1]).toMatchObject({ kind: 'skill', name: 'review', text: '# Review instructions' });
  });

  it.each([['review'], ['review', 'check']])('keeps delivered skills between neighboring messages without live-only dividers: %j', (...names) => {
    const live = skillTimeline(names, true);
    const cold = skillTimeline(names, false);
    expect(live.transcript.getItems().map(item => item.kind)).toEqual(['turn']);
    expect(live.blocks).toEqual(cold.blocks);
    expect(live.blocks.map(block => block.kind)).toEqual(['user', 'assistant', ...names.map(() => 'skill'), 'assistant']);
    expect(live.blocks.filter(block => block.kind === 'skill').map(block => [block.name, block.text, block.turnId])).toEqual(
      names.map(name => [name, `Instructions for ${name}`, 't0']),
    );
  });

  it('hides activation receipts from older live snapshots without hiding delivered content', () => {
    const { transcript } = skillTimeline(['review', 'check'], false);
    transcript.apply(['review', 'check'].map(name => ({
      op: 'marker.upsert' as const,
      item: { kind: 'marker' as const, markerId: `live-${name}`, marker: 'skill', at: AT,
        payload: { activationId: `activation-${name}`, skillName: name, trigger: 'model-tool' } },
    })));
    const blocks = agentTranscriptToBlocks({ agent_id: 'example-agent', items: transcript.getItems() });
    expect(blocks.map(block => block.kind)).toEqual(['user', 'assistant', 'skill', 'skill', 'assistant']);
    const nodes = foldHistory(groupBlocks(blocks), undefined);
    expect(nodes.map(node => node.kind)).toEqual(['user', 'assistant', 'history-fold', 'assistant']);
    const fold = nodes.find(node => node.kind === 'history-fold');
    expect(fold?.members.map(member => member.id)).toEqual(['skill-message-review', 'skill-message-check']);
  });

  it('retains durable opening skill boundaries with loaded documents', () => {
    const blocks = agentTranscriptToBlocks({ agent_id: 'main', items: [{
      kind: 'marker', markerId: 'opening', marker: 'skill', at: AT,
      payload: { text: 'Loaded document', origin: { kind: 'skill_activation', activationId: 'opening', skillName: 'review', trigger: 'user-slash' } },
    }] });
    expect(blocks).toMatchObject([{ kind: 'notice', i18n: { key: 'transcript.marker.skill' } }]);
  });

  it('does not append plugin activation receipts either', () => {
    const adapter = new AgentTranscriptLiveAdapter('main');
    expect(adapter.map({ type: 'plugin_command.activated', activationId: 'plugin-review', commandName: 'review', trigger: 'model-tool' } as unknown as LiveAdapterBusEvent)).toEqual([]);
  });
});
