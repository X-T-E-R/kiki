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
