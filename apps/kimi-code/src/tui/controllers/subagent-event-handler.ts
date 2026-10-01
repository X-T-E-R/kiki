import type {
  BackgroundTaskInfo,
  Event,
} from '@kiki/node-sdk';
import { modelDisplayName } from '../components/dialogs/model-selector';
import { MAIN_AGENT_ID } from '../constant/kimi-tui';
import type {
  BackgroundAgentMetadata,
  ToolCallBlockData,
  TranscriptEntry,
} from '../types';
import { formatBackgroundAgentTranscript } from '../utils/background-agent-status';
import { argsRecord, serializeToolResultOutput } from '../utils/event-payload';
import { formatHookResultPlain } from '../utils/hook-result-format';
import { nextTranscriptId } from '../utils/transcript-id';
import { AGENT_RUN_TOOL } from '../tool-names';
import type { SessionEventHost } from './session-event-handler';
import { SubagentActivityStore } from './subagent-activity-store';

export interface SubagentInfo {
  readonly parentToolCallId: string;
  readonly name: string;
  readonly runInBackground: boolean;
}

export type SubagentLifecycleEvent = Event & { type: `subagent.${string}` };
type SubagentLifecycleEventOf<Type extends SubagentLifecycleEvent['type']> =
  SubagentLifecycleEvent & { type: Type };

export interface SubAgentEventHandlerDependencies {
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly backgroundTaskTranscriptedTerminal: Set<string>;
  readonly syncBackgroundAgentBadge: () => void;
}

export class SubAgentEventHandler {
  readonly subagentInfo: Map<string, SubagentInfo> = new Map();
  backgroundAgentMetadata: Map<string, BackgroundAgentMetadata> = new Map();
  /** Bounded per-agent activity fold feeding the background-agent detail view. */
  readonly activityStore = new SubagentActivityStore();

  constructor(
    private readonly host: SessionEventHost,
    private readonly deps: SubAgentEventHandlerDependencies,
  ) {}

  resetRuntimeState(): void {
    this.subagentInfo.clear();
    this.backgroundAgentMetadata.clear();
    this.activityStore.clear();
  }

  routeChildAgentEvent(event: Event): boolean {
    if (isSubagentLifecycleEvent(event)) return false;

    const childAgentId = event.agentId;
    if (childAgentId === MAIN_AGENT_ID) return false;
    if (this.host.btwPanelController.routeEvent(event)) return true;

    // Tee every child-agent event into the activity store before the routing
    // below swallows events whose parent card is gone (Ctrl+B) or never
    // existed (run_in_background) — that data is the background detail view.
    this.activityStore.applyEvent(event);

    const info = this.subagentInfo.get(childAgentId);
    if (info === undefined || info.parentToolCallId.length === 0) return true;

    const { parentToolCallId } = info;

    const toolCall = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (toolCall === undefined) return true;
    toolCall.setSubagentMeta(childAgentId, info.name);

    if (event.type === 'hook.result') {
      toolCall.appendSubagentText(formatHookResultPlain(event), 'text');
    } else if (event.type === 'assistant.delta') {
      toolCall.appendSubagentText(event.delta, 'text');
    } else if (event.type === 'thinking.delta') {
      toolCall.appendSubagentText(event.delta, 'thinking');
    } else if (event.type === 'tool.call.started') {
      toolCall.appendSubToolCall({
        id: `${childAgentId}:${event.toolCallId}`,
        name: event.name,
        args: argsRecord(event.args),
      });
    } else if (event.type === 'tool.call.delta') {
      toolCall.appendSubToolCallDelta({
        id: `${childAgentId}:${event.toolCallId}`,
        name: event.name,
        argumentsPart: event.argumentsPart ?? null,
      });
    } else if (
      event.type === 'tool.progress' &&
      (event.update.kind === 'stdout' ||
        event.update.kind === 'stderr' ||
        event.update.kind === 'status') &&
      event.update.text !== undefined
    ) {
      toolCall.appendSubToolLiveOutput(
        `${childAgentId}:${event.toolCallId}`,
        event.update.text,
        { replace: event.update.replace === true },
      );
    } else if (event.type === 'tool.result') {
      toolCall.finishSubToolCall({
        tool_call_id: `${childAgentId}:${event.toolCallId}`,
        output: serializeToolResultOutput(event.output),
        is_error: event.isError,
      });
    } else if (event.type === 'agent.status.updated') {
      const usageObj = event.usage;
      const totalUsage = usageObj?.total ?? usageObj?.currentTurn;
      toolCall.updateSubagentMetrics({
        contextTokens: event.contextTokens,
        usage: totalUsage,
        // The bound model alias rides every child status update (emitted right
        // after spawn); surface it on the subagent card. `modelDisplayName`
        // falls back to the alias itself when the entry is unknown.
        modelDisplay:
          event.model === undefined
            ? undefined
            : modelDisplayName(event.model, this.host.state.appState.availableModels[event.model]),
        effortDisplay: this.subagentEffortDisplay(event.thinkingEffort),
      });
    }
    return true;
  }

  handleLifecycleEvent(event: SubagentLifecycleEvent): void {
    switch (event.type) {
      case 'subagent.spawned':
        this.handleSubagentSpawned(event);
        return;
      case 'subagent.started':
        this.handleSubagentStarted(event);
        return;
      case 'subagent.completed':
        this.handleSubagentCompleted(event);
        return;
      case 'subagent.failed':
        this.handleSubagentFailed(event);
        return;
    }
  }

  private handleSubagentSpawned(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): void {
    this.rememberSubagent(event);

    if (event.runInBackground) {
      const meta = this.buildBackgroundAgentMetadata(event);
      this.backgroundAgentMetadata.set(event.subagentId, meta);
      this.appendBackgroundAgentEntry('started', meta);
      this.deps.syncBackgroundAgentBadge();
      return;
    }

    this.handleForegroundSubagentSpawned(event);
  }

  private handleSubagentStarted(
    event: SubagentLifecycleEventOf<'subagent.started'>,
  ): void {
    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined) return;
    if (!info.runInBackground) this.handleForegroundSubagentStarted(event, info);
  }

  private handleSubagentCompleted(
    event: SubagentLifecycleEventOf<'subagent.completed'>,
  ): void {
    this.activityStore.markCompleted(event.subagentId, event.resultSummary);
    this.pruneForegroundOnlyRecord(event.subagentId);
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      const taskId = this.findAgentTaskId(
        event.subagentId,
        backgroundMeta,
        this.deps.backgroundTasks,
      );
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.deps.syncBackgroundAgentBadge();
      if (taskId !== undefined && this.deps.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.deps.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      const extras =
        event.resultSummary === undefined ? undefined : { resultSummary: event.resultSummary };
      this.appendBackgroundAgentEntry('completed', backgroundMeta, extras);
      return;
    }

    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined || info.runInBackground) return;
    this.handleForegroundSubagentCompleted(event, info);
  }

  private handleSubagentFailed(
    event: SubagentLifecycleEventOf<'subagent.failed'>,
  ): void {
    this.activityStore.markFailed(event.subagentId, event.error);
    this.pruneForegroundOnlyRecord(event.subagentId);
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      const taskId = this.findAgentTaskId(
        event.subagentId,
        backgroundMeta,
        this.deps.backgroundTasks,
      );
      const task = taskId === undefined ? undefined : this.deps.backgroundTasks.get(taskId);
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.deps.syncBackgroundAgentBadge();
      if (task?.kind === 'agent' && task.status === 'timed_out') {
        return;
      }
      this.host.streamingUI.applyBackgroundTaskTerminalStatus({
        agentId: event.subagentId,
        description: backgroundMeta.description ?? '',
        status: 'failed',
        errorText: event.error,
      });
      if (taskId !== undefined && this.deps.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.deps.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      this.appendBackgroundAgentEntry('failed', backgroundMeta, { error: event.error });
      return;
    }

    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined || info.runInBackground) return;
    this.handleForegroundSubagentFailed(event, info);
  }

  private findAgentTaskId(
    subagentId: string,
    meta: BackgroundAgentMetadata,
    backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>,
  ): string | undefined {
    for (const info of backgroundTasks.values()) {
      if (info.kind !== 'agent') continue;
      if (info.agentId === subagentId) return info.taskId;
    }
    const description = meta.description ?? meta.agentName;
    if (description === undefined) return undefined;
    let match: string | undefined;
    for (const info of backgroundTasks.values()) {
      if (info.kind !== 'agent') continue;
      if (info.description !== description) continue;
      if (match !== undefined) return undefined;
      match = info.taskId;
    }
    return match;
  }

  /** A subagent that never became a background task (foreground-only) can
   *  never appear in /tasks, so its activity record is dropped at terminal
   *  state — otherwise records would pile up for the rest of the session. */
  private pruneForegroundOnlyRecord(subagentId: string): void {
    // A spawn-time background agent keeps its record even when the
    // background.task.started sync has not landed yet (short-lived agents).
    if (this.backgroundAgentMetadata.has(subagentId)) return;
    for (const info of this.deps.backgroundTasks.values()) {
      if (info.kind === 'agent' && info.agentId === subagentId) return;
    }
    this.activityStore.drop(subagentId);
  }

  /** Drop every foreground-only record. Called when the main turn ends: any
   *  foreground subagent of the turn is over at that point, and an aborted
   *  one emits no `subagent.completed`/`subagent.failed` to prune it. */
  dropForegroundOnlyActivityRecords(): void {
    for (const agentId of this.activityStore.agentIds()) {
      this.pruneForegroundOnlyRecord(agentId);
    }
  }

  private buildBackgroundAgentMetadata(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): BackgroundAgentMetadata {
    const parent = this.host.streamingUI.getActiveToolCall(event.parentToolCallId);
    const description = parent?.args['description'] ?? event.description;
    return {
      agentId: event.subagentId,
      parentToolCallId: event.parentToolCallId,
      agentName: event.subagentName,
      description: typeof description === 'string' ? description : undefined,
      model: this.spawnedModelDisplay(event),
      effort: this.subagentEffortDisplay(event.thinkingEffort),
    };
  }

  private appendBackgroundAgentEntry(
    phase: 'started' | 'completed' | 'failed',
    meta: BackgroundAgentMetadata,
    extras: { resultSummary?: string; error?: string } | undefined = undefined,
  ): void {
    const status = formatBackgroundAgentTranscript(phase, meta, extras);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private rememberSubagent(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): void {
    this.subagentInfo.set(event.subagentId, {
      parentToolCallId: event.parentToolCallId,
      name: event.subagentName,
      runInBackground: event.runInBackground,
    });
    this.activityStore.ensureRecord({
      agentId: event.subagentId,
      agentName: event.subagentName,
      description: event.description,
      parentToolCallId: event.parentToolCallId,
      model: this.spawnedModelDisplay(event),
      effort: this.subagentEffortDisplay(event.thinkingEffort),
    });
  }

  private handleForegroundSubagentSpawned(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): void {
    // The spawned event carries the display-normalized bound alias (newer
    // cores) — show it at spawn instead of waiting for the child's first
    // status frame. The `agent.status.updated` channel below stays as the
    // in-run update/fallback path.
    const modelDisplay = this.spawnedModelDisplay(event);
    const effortDisplay = this.subagentEffortDisplay(event.thinkingEffort);

    let tc = this.getOrActivateToolComponent(event.parentToolCallId);
    tc ??= this.createStandaloneSubagentToolCall(event);
    if (tc === undefined) return;
    tc.onSubagentSpawned({
      agentId: event.subagentId,
      agentName: event.subagentName,
      runInBackground: event.runInBackground,
    });
    if (modelDisplay !== undefined || effortDisplay !== undefined) {
      tc.updateSubagentMetrics({ modelDisplay, effortDisplay });
    }
  }

  /** Map the spawned event's bound alias to a display name via the loaded
   *  model catalog; falls back to the alias itself for unknown entries. */
  private spawnedModelDisplay(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): string | undefined {
    if (event.model === undefined) return undefined;
    return modelDisplayName(event.model, this.host.state.appState.availableModels[event.model]);
  }

  /** Concrete effort levels are always shown; the boolean states carry no
   *  level information — 'off' (no thinking) and 'on' (generic thinking) are
   *  both hidden. */
  private subagentEffortDisplay(effort: string | undefined): string | undefined {
    if (effort === undefined || effort === 'off' || effort === 'on') return undefined;
    return effort;
  }

  private handleForegroundSubagentStarted(
    event: SubagentLifecycleEventOf<'subagent.started'>,
    info: SubagentInfo,
  ): void {

    const tc = this.getOrActivateToolComponent(info.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentStarted({
      agentId: event.subagentId,
      agentName: info.name,
      runInBackground: info.runInBackground,
    });
  }

  private handleForegroundSubagentCompleted(
    event: SubagentLifecycleEventOf<'subagent.completed'>,
    info: SubagentInfo,
  ): void {
    const { parentToolCallId } = info;

    const tc = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentCompleted({
      contextTokens: event.contextTokens,
      usage: event.usage,
      resultSummary: event.resultSummary,
    });
    this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
  }

  private handleForegroundSubagentFailed(
    event: SubagentLifecycleEventOf<'subagent.failed'>,
    info: SubagentInfo,
  ): void {
    const { parentToolCallId } = info;

    const tc = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentFailed({ error: event.error });
    this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
  }

  private getOrActivateToolComponent(parentToolCallId: string) {
    let component = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (component !== undefined) return component;
    const toolCall = this.host.streamingUI.getActiveToolCall(parentToolCallId);
    if (toolCall === undefined) return undefined;
    this.host.streamingUI.onToolCallStart(toolCall);
    return this.host.streamingUI.getToolComponent(parentToolCallId);
  }

  private createStandaloneSubagentToolCall(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ) {
    const description = event.description ?? `Run ${event.subagentName} agent`;
    const { turnId, step } = this.host.streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.parentToolCallId,
      name: AGENT_RUN_TOOL,
      args: {
        profile: event.subagentName,
      },
      description,
      step,
      turnId,
    };
    this.host.streamingUI.onToolCallStart(toolCall);
    return this.host.streamingUI.getToolComponent(event.parentToolCallId);
  }
}

function isSubagentLifecycleEvent(event: Event): event is SubagentLifecycleEvent {
  return (
    event.type === 'subagent.spawned' ||
    event.type === 'subagent.started' ||
    event.type === 'subagent.suspended' ||
    event.type === 'subagent.completed' ||
    event.type === 'subagent.failed'
  );
}
