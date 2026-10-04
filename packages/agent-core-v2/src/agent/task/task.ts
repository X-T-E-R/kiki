import { createDecorator } from '#/_base/di/instantiation';
import type { ITaskHandle } from '#/app/task/task';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { MediaTaskInfo } from './types';
import type {
  AgentTask,
  AgentTaskInfo,
  AgentTaskInfoBase,
  AgentTaskStatus,
  TaskLifetime,
} from './types';

export { AgentTaskPersistence } from './persist';
export type {
  AgentTask,
  AgentTaskInfo,
  AgentTaskInfoBase,
  AgentTaskReceipt,
  AgentTaskKind,
  AgentTaskStatus,
  TaskLifetime,
} from './types';

export interface AgentTaskLoadOptions {
  readonly replace?: boolean;
}

export interface AgentTaskOutputSnapshot {
  readonly outputPath?: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

export interface AgentTaskOutputPage {
  readonly outputPath: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly totalBytes: number;
  readonly hasMore: boolean;
  readonly text: string;
}

export interface RegisterAgentTaskOptions {
  readonly detached?: boolean;
  readonly lifetime?: TaskLifetime;
  readonly timeoutMs?: number;
  readonly detachTimeoutMs?: number;
  readonly autoBackgroundOnTimeout?: boolean;
  readonly signal?: AbortSignal;
  /** Preallocated by a transactional adapter before the task starts. */
  readonly taskId?: string;
  /** Keep the task private until a transactional caller commits registration. */
  readonly deferVisibility?: boolean;
}

export type ForegroundTaskReleaseReason = 'detached' | 'timeout_detached' | 'terminal';

export interface AgentTaskTrackOptions {
  readonly idPrefix?: string;
  readonly description: string;
  readonly detached?: boolean;
  readonly lifetime?: TaskLifetime;
  readonly timeoutMs?: number;
  readonly detachTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly forceStop?: () => Promise<void>;
  readonly onDetach?: () => void;
  readonly toInfo: (base: AgentTaskInfoBase) => AgentTaskInfo;
}

export interface IAgentTaskEntry {
  readonly taskId: string;
  readonly onDidDetach: Promise<ForegroundTaskReleaseReason>;
}

export interface AgentTaskNotificationContext {
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning';
  readonly sourceKind: string;
  readonly sourceId: string;
}

export interface AgentTaskWaitDelivery {
  readonly taskId: string;
  readonly status: AgentTaskStatus;
}

export interface IAgentTaskService {
  readonly _serviceBrand: undefined;

  track(handle: ITaskHandle, options: AgentTaskTrackOptions): IAgentTaskEntry;
  allocateTaskId?(idPrefix: string): string;
  registerTask(task: AgentTask, options?: RegisterAgentTaskOptions): string;
  registerMediaRecovery?(handler: (info: MediaTaskInfo) => Promise<AgentTask | undefined>): IDisposable;
  commitTaskRegistration?(taskId: string): void;
  rollbackTaskRegistration?(taskId: string, reason?: unknown): Promise<void>;
  getTask(taskId: string): AgentTaskInfo | undefined;
  getTaskSnapshot(taskId: string): Promise<AgentTaskInfo | undefined>;
  list(activeOnly?: boolean, limit?: number, offset?: number): readonly AgentTaskInfo[];
  persistOutput(taskId: string): void;
  getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot>;
  getOutputPage(taskId: string, offset: number, maxBytes: number): Promise<AgentTaskOutputPage | undefined>;
  readOutput(taskId: string, tail?: number): Promise<string>;
  suppressTerminalNotification(taskId: string): Promise<void>;
  /**
   * Silence every terminal notification in this agent scope from now on — the
   * teardown path calls it before stopping tasks, so a task that settles after
   * the agent is gone (or while it is being torn down) never notifies the
   * model or fires the notification hook.
   *
   * One-shot and irreversible: it arms a scope-wide latch plus aborts the
   * notifications already queued on the loop, and nothing re-arms the scope.
   * Only call it when the scope is going away; calling it on a live agent
   * permanently mutes every background-task notification for that scope.
   */
  suppressAllTerminalNotifications(): Promise<void>;
  markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[], toolCallId?: string, signal?: AbortSignal): void;
  detach(taskId: string): AgentTaskInfo | undefined;
  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined>;
  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined>;
  stopAll(reason?: string): Promise<readonly AgentTaskInfo[]>;
  stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]>;
  wait(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined>;
  waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined>;
}

export const IAgentTaskService =
  createDecorator<IAgentTaskService>('agentTaskService');
