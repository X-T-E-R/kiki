import { describe, expect, it, vi } from 'vitest';

import { buildAgentForest, type AgentForest } from './agentTree';
import {
  selectAgentCapabilities,
  selectAgentSummary,
  selectAgentTimelineState,
  type AgentWorkspaceSource,
} from './agentWorkspace';
import { createViewState, type SessionViewState } from './transcript';

function source(options: {
  main?: Partial<SessionViewState>;
  child?: Partial<SessionViewState>;
  forest?: AgentForest;
} = {}): AgentWorkspaceSource {
  const empty = createViewState('session-shared');
  const main = { ...empty, ...options.main };
  const child = { ...empty, ...options.child };
  return {
    sessionId: 'session-shared',
    getState: () => main,
    getAgentState: vi.fn((id) => id === 'child-1' ? child : empty),
    getAgentTranscriptCursor: (id) => id === 'child-1' && child.transcriptReady ? { seq: 7, epoch: 'child-epoch' } : undefined,
    getForest: () => options.forest,
  };
}

describe('agent workspace selectors', () => {
  it('separates session loaded from target transcript ready and never fills a missing child from main', () => {
    const runtime = source({ main: {
      loaded: true, transcriptReady: true, busy: true, model: 'main-model',
      profile: 'main-profile', thinkingEffort: 'high', usage: { byModel: {} },
      blocks: [{ kind: 'notice', id: 'main-only', text: 'main-only', tone: 'neutral' }],
    } });
    expect(selectAgentSummary(runtime, 'child-1')).toMatchObject({
      target: { sessionId: 'session-shared', agentId: 'child-1' }, kind: 'child',
      busy: undefined, model: undefined, profile: undefined, thinkingEffort: undefined, usage: undefined,
    });
    expect(selectAgentTimelineState(runtime, 'child-1')).toMatchObject({
      sessionLoaded: true, status: 'loading', ready: false, blocks: [], cursor: undefined,
    });
    expect(selectAgentCapabilities(runtime, 'child-1').inspect).toEqual({ enabled: false, unavailableReason: 'agent-not-loaded' });
    expect(selectAgentSummary(runtime, 'main')).toMatchObject({ kind: 'main', busy: true, model: 'main-model', profile: 'main-profile' });
    expect(selectAgentTimelineState(runtime, 'main').blocks).toBe(runtime.getState().blocks);
    expect(runtime.getAgentState).not.toHaveBeenCalledWith('main');
  });

  it('projects child identity and configuration from only its own state and forest node', () => {
    const forest = buildAgentForest([], [{
      agentId: 'child-1', parentAgentId: 'parent-1', name: 'Research', model: 'roster-model',
      thinkingEffort: 'medium', status: 'completed',
    }, { agentId: 'parent-1', name: 'Parent' }]);
    const runtime = source({
      main: { loaded: true, model: 'main-model', usage: { byModel: {} } },
      child: { loaded: true, transcriptReady: true, model: 'child-model', profile: 'child-profile', busy: false },
      forest,
    });
    expect(selectAgentSummary(runtime, 'child-1')).toMatchObject({
      name: 'Research', parentAgentId: 'parent-1', lifecycle: 'completed', busy: false,
      model: 'child-model', profile: 'child-profile', thinkingEffort: 'medium', usage: undefined,
    });
    expect(selectAgentSummary(runtime, 'missing').model).toBeUndefined();
  });

  it('exposes target pagination, reset generation and transcript cursor without mixing session cursors', () => {
    const runtime = source({
      main: { loaded: true, cursor: { seq: 900, epoch: 'session-epoch' }, transcriptResetVersion: 15, resyncing: true },
      child: {
        loaded: true, transcriptReady: true, transcriptResetVersion: 2, hasMoreHistory: true,
        oldestMessageId: 'oldest-child', loadingOlder: true, olderError: 'page unavailable',
        blocks: [{ kind: 'notice', id: 'child-only', text: 'child-only', tone: 'neutral' }],
      },
    });
    expect(selectAgentTimelineState(runtime, 'child-1')).toMatchObject({
      sessionLoaded: true, status: 'ready', ready: true, resetGeneration: 2,
      cursor: { seq: 7, epoch: 'child-epoch' }, hasMoreHistory: true,
      oldestMessageId: 'oldest-child', loadingOlder: true, olderError: 'page unavailable', resyncing: true,
    });
    expect(selectAgentTimelineState(runtime, 'child-1').blocks).toBe(runtime.getAgentState('child-1').blocks);
  });

  it('keeps session errors distinct from a child transcript load error', () => {
    const runtime = source({ main: { loadError: 'session unavailable' }, child: { loadError: 'child unavailable' } });
    expect(selectAgentTimelineState(runtime, 'child-1')).toMatchObject({
      status: 'error', error: 'child unavailable', sessionError: 'session unavailable', sessionLoaded: false,
    });
    expect(selectAgentTimelineState(runtime, 'missing')).toMatchObject({
      status: 'loading', error: undefined, sessionError: 'session unavailable',
    });
  });

  it('permits historical inspection without inferring runtime command authority', () => {
    const runtime = source({ main: { loaded: true }, child: { loaded: true, transcriptReady: true } });
    for (const id of ['main', 'child-1']) {
      const capabilities = selectAgentCapabilities(runtime, id);
      expect(capabilities.inspect).toEqual({ enabled: true });
      for (const key of ['send', 'stop', 'configure', 'interactions'] as const) {
        expect(capabilities[key]).toEqual({ enabled: false, unavailableReason: 'not-reported' });
      }
    }
  });
});
