import { describe, expect, it } from 'vitest';
import { sumAgentTreeMetrics, UNKNOWN_AGENT_PANEL_METRICS } from './agentPanel';
import { AgentTranscript } from '@kiki/transcript';
import { projectAgentTranscriptView } from './transcript/project';
import { createViewState } from './transcript/types';

describe('agent panel tree accounting', () => {
  it('projects independent agent stores even when their todo document ids are identical', () => {
    const main = new AgentTranscript('main');
    const child = new AgentTranscript('child');
    main.apply([{ op: 'todo.upsert', todo: { todoId: 'todo', items: [{ title: 'main only', status: 'pending' }] } }]);
    child.apply([{ op: 'todo.upsert', todo: { todoId: 'todo', items: [{ title: 'child only', status: 'in_progress' }] } }]);
    const mainState = projectAgentTranscriptView(createViewState('session'), 'main', main.snapshot());
    const childState = projectAgentTranscriptView(createViewState('session'), 'child', child.snapshot());
    expect(mainState.todos).toEqual([{ title: 'main only', status: 'pending' }]);
    expect(childState.todos).toEqual([{ title: 'child only', status: 'in_progress' }]);
    child.apply([{ op: 'todo.upsert', todo: { todoId: 'todo', items: [] } }]);
    expect(projectAgentTranscriptView(childState, 'child', child.snapshot()).todos).toEqual([]);
    expect(projectAgentTranscriptView(mainState, 'main', main.snapshot()).todos).toEqual(mainState.todos);
  });

  it('keeps per-agent notes isolated and removes stale notes after a reset or clear', () => {
    const main = new AgentTranscript('main');
    const child = new AgentTranscript('child');
    const notesMeta = { rev: 1, hash: 'notes-hash', writtenTurn: 0, writtenStep: 't0.1', coveredMessageId: 'msg-1', windowEpoch: 0 };
    main.apply([{ op: 'todo.upsert', todo: { todoId: 'todo', items: [], notes: { goal: 'Main goal' }, notesMeta } }]);
    child.apply([{ op: 'todo.upsert', todo: { todoId: 'todo', items: [], notes: { goal: 'Child goal', directives: 'Read only' }, notesMeta } }]);
    const mainState = projectAgentTranscriptView(createViewState('session'), 'main', main.snapshot());
    const childState = projectAgentTranscriptView(createViewState('session'), 'child', child.snapshot());
    expect(mainState.todoNotes).toEqual({ goal: 'Main goal' });
    expect(childState.todoNotes).toEqual({ goal: 'Child goal', directives: 'Read only' });
    expect(childState.todoNotesMeta).toEqual(notesMeta);
    child.apply([{ op: 'todo.upsert', todo: { todoId: 'todo', items: [], notesMeta: { ...notesMeta, rev: 2 } } }]);
    expect(projectAgentTranscriptView(childState, 'child', child.snapshot()).todoNotes).toBeUndefined();
    expect(projectAgentTranscriptView(childState, 'child', child.snapshot()).todoNotesMeta?.rev).toBe(2);
    expect(projectAgentTranscriptView(mainState, 'main', main.snapshot()).todoNotes).toEqual({ goal: 'Main goal' });
    child.apply([{ op: 'reset', agentId: 'child', snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {} } }]);
    const reset = projectAgentTranscriptView(childState, 'child', child.snapshot());
    expect(reset.todoNotes).toBeUndefined();
    expect(reset.todoNotesMeta).toBeUndefined();
  });

  it('counts each agent once and does not accept subagent completion summaries as extra records', () => {
    const metrics = {
      main: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 100, totalCostUsd: 1 },
      child: { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 20, totalCostUsd: 0.2 },
    };
    expect(sumAgentTreeMetrics(['main', 'child', 'child'], metrics)).toEqual({ totalTokens: 120, totalCostUsd: 1.2 });
  });
  it('keeps missing agent records and missing price information explicitly unknown', () => {
    const main = { ...UNKNOWN_AGENT_PANEL_METRICS, totalTokens: 0, totalCostUsd: 0 };
    expect(sumAgentTreeMetrics(['main', 'missing'], { main })).toEqual({ totalTokens: 0, totalCostUsd: 0 });
    expect(sumAgentTreeMetrics(['main'], { main })).toEqual({ totalTokens: 0, totalCostUsd: 0 });
    expect(sumAgentTreeMetrics(['main'], { main: { ...main, totalCostUsd: null } })).toEqual({ totalTokens: 0, totalCostUsd: null });
    expect(sumAgentTreeMetrics([], {})).toEqual({ totalTokens: null, totalCostUsd: null });
  });
});
