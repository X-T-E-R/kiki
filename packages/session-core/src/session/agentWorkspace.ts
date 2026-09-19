import type { TranscriptCursor } from '@kiki/transcript';

import { MAIN_AGENT_ID, type AgentForest, type AgentStatus } from './agentTree';
import type { Block, SessionViewState } from './transcript';

export interface AgentTarget {
  readonly sessionId: string;
  readonly agentId: string;
}

/** A controller-backed source, scoped to one connection and session. */
export interface AgentWorkspaceSource {
  readonly sessionId: string;
  getState(): SessionViewState;
  getAgentState(agentId: string): SessionViewState;
  getAgentTranscriptCursor(agentId: string): TranscriptCursor | undefined;
  getForest(): AgentForest | undefined;
}

export interface AgentSummary {
  readonly target: AgentTarget;
  readonly kind: 'main' | 'child';
  readonly name: string | undefined;
  readonly parentAgentId: string | undefined;
  readonly lifecycle: AgentStatus | undefined;
  readonly busy: boolean | undefined;
  readonly model: string | undefined;
  readonly thinkingEffort: string | undefined;
  /** Reported binding only; pending configuration is not available from this source. */
  readonly profile: string | undefined;
  readonly usage: SessionViewState['usage'];
}

export interface AgentTimelineState {
  readonly target: AgentTarget;
  readonly sessionLoaded: boolean;
  readonly status: 'loading' | 'ready' | 'error';
  readonly ready: boolean;
  readonly error: string | undefined;
  readonly sessionError: string | undefined;
  readonly blocks: readonly Block[];
  readonly cursor: TranscriptCursor | undefined;
  readonly resetGeneration: number;
  readonly hasMoreHistory: boolean;
  readonly oldestMessageId: string | undefined;
  readonly loadingOlder: boolean;
  readonly olderError: string | undefined;
  readonly resyncing: boolean;
  readonly resyncFailed: boolean;
}

export type AgentCapability =
  | { readonly enabled: true; readonly unavailableReason?: never; readonly effectiveAt?: 'immediate' | 'next-step' | 'next-run' | 'next-prompt' }
  | { readonly enabled: false; readonly unavailableReason: 'not-reported' | 'agent-not-loaded'; readonly effectiveAt?: never };

export interface AgentCapabilities {
  readonly target: AgentTarget;
  readonly send: AgentCapability;
  readonly stop: AgentCapability;
  readonly configure: AgentCapability;
  readonly inspect: AgentCapability;
  readonly interactions: AgentCapability;
}

function targetState(source: AgentWorkspaceSource, agentId: string): SessionViewState {
  return agentId === MAIN_AGENT_ID ? source.getState() : source.getAgentState(agentId);
}

/** Project only this target's fields; a child never inherits main's configuration or usage. */
export function selectAgentSummary(source: AgentWorkspaceSource, agentId: string): AgentSummary {
  const state = targetState(source, agentId);
  const node = source.getForest()?.byId[agentId];
  const main = agentId === MAIN_AGENT_ID;
  return {
    target: { sessionId: source.sessionId, agentId },
    kind: main ? 'main' : 'child',
    name: node?.name,
    parentAgentId: node?.parentAgentId,
    lifecycle: node?.status,
    busy: state.transcriptReady || (main && state.loaded) ? state.busy : node?.busy,
    model: state.model ?? node?.model,
    thinkingEffort: state.thinkingEffort ?? node?.thinkingEffort,
    profile: state.profile,
    usage: state.usage,
  };
}

/** Keep session-shell readiness separate from the target's transcript readiness and cursor. */
export function selectAgentTimelineState(source: AgentWorkspaceSource, agentId: string): AgentTimelineState {
  const state = targetState(source, agentId);
  const session = source.getState();
  return {
    target: { sessionId: source.sessionId, agentId },
    sessionLoaded: session.loaded,
    status: state.loadError !== undefined ? 'error' : state.transcriptReady ? 'ready' : 'loading',
    ready: state.transcriptReady,
    error: state.loadError,
    sessionError: session.loadError,
    blocks: state.blocks,
    cursor: source.getAgentTranscriptCursor(agentId),
    resetGeneration: state.transcriptResetVersion,
    hasMoreHistory: state.hasMoreHistory,
    oldestMessageId: state.oldestMessageId,
    loadingOlder: state.loadingOlder,
    olderError: state.olderError,
    resyncing: session.resyncing,
    resyncFailed: session.resyncFailed,
  };
}

const UNREPORTED_CAPABILITY: AgentCapability = Object.freeze({ enabled: false, unavailableReason: 'not-reported' });
const INSPECT_AVAILABLE: AgentCapability = Object.freeze({ enabled: true });
const INSPECT_UNAVAILABLE: AgentCapability = Object.freeze({ enabled: false, unavailableReason: 'agent-not-loaded' });

/** History permits inspection, not runtime commands; authoritative command capabilities are not yet reported. */
export function selectAgentCapabilities(source: AgentWorkspaceSource, agentId: string): AgentCapabilities {
  const state = targetState(source, agentId);
  const known = state.transcriptReady || source.getForest()?.byId[agentId] !== undefined ||
    (agentId === MAIN_AGENT_ID && state.loaded);
  return {
    target: { sessionId: source.sessionId, agentId },
    send: UNREPORTED_CAPABILITY,
    stop: UNREPORTED_CAPABILITY,
    configure: UNREPORTED_CAPABILITY,
    inspect: known ? INSPECT_AVAILABLE : INSPECT_UNAVAILABLE,
    interactions: UNREPORTED_CAPABILITY,
  };
}
