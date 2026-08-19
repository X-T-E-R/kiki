import type { Event } from './events';
import type { SnapshotSubagent } from '../../../protocol/rest-snapshot';
import { resolveSubagentDisplayName } from '../../../services/subagentProjection';

const MAIN_AGENT_ID = 'main';

export class SubagentRosterTracker {
  private readonly bySession = new Map<string, Map<string, SnapshotSubagent>>();
  private readonly toolCallsBySession = new Map<string, Map<string, Set<string>>>();

  apply(sessionId: string, event: Event): void {
    switch (event.type) {
      case 'subagent.spawned': {
        if (event.runInBackground === true) return;
        let roster = this.bySession.get(sessionId);
        if (!roster) {
          roster = new Map();
          this.bySession.set(sessionId, roster);
        }
        roster.set(event.subagentId, {
          id: event.subagentId,
          session_id: sessionId,
          kind: 'subagent',
          description: resolveSubagentDisplayName(
            event.userLabel,
            event.subagentName,
            event.subagentId,
          ),
          status: 'running',
          subagent_phase: 'queued',
          subagent_type: event.subagentName,
          label: event.userLabel,
          parent_agent_id: event.parentAgentId,
          parent_tool_call_id: event.parentToolCallId === '' ? undefined : event.parentToolCallId,
          tool_call_count: 0,
          swarm_index: event.swarmIndex,
          run_in_background: event.runInBackground,
          model: event.model,
          thinking_effort: event.thinkingEffort,
          created_at: new Date().toISOString(),
        });
        let toolCalls = this.toolCallsBySession.get(sessionId);
        if (!toolCalls) {
          toolCalls = new Map();
          this.toolCallsBySession.set(sessionId, toolCalls);
        }
        toolCalls.set(event.subagentId, new Set());
        return;
      }
      case 'subagent.started': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'working';
        entry.suspended_reason = undefined;
        entry.started_at ??= new Date().toISOString();
        return;
      }
      case 'subagent.suspended': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'suspended';
        entry.suspended_reason = event.reason;
        return;
      }
      case 'subagent.completed': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'completed';
        entry.status = 'completed';
        entry.completed_at = new Date().toISOString();
        entry.output_preview = event.resultSummary;
        return;
      }
      case 'subagent.failed': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry) return;
        entry.subagent_phase = 'failed';
        entry.status = 'failed';
        entry.completed_at = new Date().toISOString();
        entry.output_preview = event.error;
        return;
      }
      case 'tool.call.started': {
        const entry = this.bySession.get(sessionId)?.get(event.agentId);
        if (!entry) return;
        let toolCalls = this.toolCallsBySession.get(sessionId)?.get(event.agentId);
        if (!toolCalls) {
          toolCalls = new Set();
          let byAgent = this.toolCallsBySession.get(sessionId);
          if (!byAgent) {
            byAgent = new Map();
            this.toolCallsBySession.set(sessionId, byAgent);
          }
          byAgent.set(event.agentId, toolCalls);
        }
        toolCalls.add(event.toolCallId);
        entry.tool_call_count = toolCalls.size;
        return;
      }
      case 'task.started': {
        const info = event.info;
        if (info.kind === 'agent' && info.detached === true && info.agentId !== undefined) {
          this.bySession.get(sessionId)?.delete(info.agentId);
          this.toolCallsBySession.get(sessionId)?.delete(info.agentId);
        }
        return;
      }
      case 'turn.ended': {
        if (event.agentId !== MAIN_AGENT_ID) return;
        const roster = this.bySession.get(sessionId);
        if (roster === undefined || event.reason === 'completed') return;
        for (const entry of roster.values()) {
          if (entry.status !== 'running') continue;
          entry.status = 'failed';
          entry.subagent_phase = 'failed';
          entry.completed_at = new Date().toISOString();
          entry.output_preview ??= `Main turn ${event.reason}`;
        }
        return;
      }
      case 'turn.started': {
        if (event.agentId === MAIN_AGENT_ID) {
          this.bySession.delete(sessionId);
          this.toolCallsBySession.delete(sessionId);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Fresh copies — callers must not mutate the tracked entries. */
  get(sessionId: string): SnapshotSubagent[] {
    const roster = this.bySession.get(sessionId);
    if (!roster) return [];
    return Array.from(roster.values(), (entry) => ({ ...entry }));
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.toolCallsBySession.delete(sessionId);
  }
}
