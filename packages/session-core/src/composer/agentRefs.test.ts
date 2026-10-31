import { describe, expect, it } from 'vitest';

import {
  agentRefDeletionRange,
  agentRefLink,
  findAgentRefs,
  removeAgentRef,
  replaceMentionTriggerWithAgentRef,
} from './agentRefs';

describe('agentRefLink / findAgentRefs', () => {
  it('round-trips a profile through the link and back', () => {
    const link = agentRefLink('worker');
    expect(link).toBe('kiki://agents/worker');
    expect(findAgentRefs(`ask ${link} now`)).toEqual([
      { start: 4, end: 4 + link.length, raw: link, profile: 'worker' },
    ]);
  });

  it('encodes profiles that need it and finds several in order', () => {
    // A profile carrying a `/` encodes it so the link token stays one span.
    const text = `${agentRefLink('explore')} then ${agentRefLink('worker')} and ${agentRefLink('explore')}`;
    const refs = findAgentRefs(text);
    expect(refs.map((ref) => ref.profile)).toEqual(['explore', 'worker', 'explore']);
  });
});

describe('replaceMentionTriggerWithAgentRef', () => {
  it('replaces the @query trigger with the link plus a trailing space', () => {
    const text = 'please @wor';
    const trigger = { start: 7 };
    const cursor = text.length;
    expect(replaceMentionTriggerWithAgentRef(text, trigger, cursor, agentRefLink('worker'))).toEqual({
      text: 'please kiki://agents/worker ',
      cursor: 'please kiki://agents/worker '.length,
    });
  });

  it('drops the whole typed query, not just the caret suffix', () => {
    const text = '@cod hello';
    const trigger = { start: 0 };
    const cursor = 4; // caret right after the query, before the space
    expect(replaceMentionTriggerWithAgentRef(text, trigger, cursor, agentRefLink('codex'))).toEqual({
      text: 'kiki://agents/codex hello',
      cursor: 'kiki://agents/codex'.length,
    });
  });

  it('does not double a space that already follows the trigger', () => {
    const text = '@ more';
    const trigger = { start: 0 };
    const cursor = 1;
    const next = replaceMentionTriggerWithAgentRef(text, trigger, cursor, agentRefLink('agent'));
    expect(next.text).toBe('kiki://agents/agent more');
    expect(next.cursor).toBe('kiki://agents/agent'.length);
  });

  it('supports referencing the same target twice', () => {
    const first = replaceMentionTriggerWithAgentRef('@a', { start: 0 }, 2, agentRefLink('worker'));
    const second = replaceMentionTriggerWithAgentRef(`${first.text}and @w`, { start: first.text.length + 4 }, first.text.length + 6, agentRefLink('worker'));
    expect(findAgentRefs(second.text).map((ref) => ref.profile)).toEqual(['worker', 'worker']);
  });
});

describe('agentRefDeletionRange / removeAgentRef', () => {
  const link = agentRefLink('worker');
  const text = `a ${link} b`;
  const start = 2;
  const end = start + link.length;

  it('widens Backspace after, Delete before, and overlapping selections to the whole link', () => {
    expect(agentRefDeletionRange(text, end, end, 'Backspace')).toEqual({ start, end });
    expect(agentRefDeletionRange(text, start, start, 'Delete')).toEqual({ start, end });
    expect(agentRefDeletionRange(text, start + 3, start + 3, 'Backspace')).toEqual({ start, end });
    expect(agentRefDeletionRange(text, 0, start + 3, 'Backspace')).toEqual({ start: 0, end });
    expect(agentRefDeletionRange(text, start, start, 'Backspace')).toBeNull();
    expect(agentRefDeletionRange(text, 1, 1, 'Backspace')).toBeNull();
  });

  it('returns null when no agent link is present', () => {
    expect(agentRefDeletionRange('plain text', 3, 3, 'Backspace')).toBeNull();
  });

  it('removes a link with one separating space', () => {
    expect(removeAgentRef(text, { start, end })).toEqual({ text: 'a b', cursor: 2 });
  });

  it('removes only the touched link when several are present', () => {
    const two = `${link} and ${link}`;
    const refs = findAgentRefs(two);
    expect(refs).toHaveLength(2);
    const next = removeAgentRef(two, refs[1]!);
    expect(findAgentRefs(next.text).map((ref) => ref.profile)).toEqual(['worker']);
  });
});
