import type { ContentPart, Message } from '#/kosong/contract/message';
import type { ExternalClientSessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import type { AgentTaskStatus } from '#/agent/task/task';
import type { ThreadRef } from '#/app/threadCommunication/threadCommunication';
import type { BridgedThreadMetadata } from '#/app/threadCommunication/threadMailboxStore';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface UserPromptOrigin {
  readonly kind: 'user';
  readonly skillActivations?: readonly BundledSkillActivation[];
  readonly originalInput?: readonly ContentPart[];
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

export interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly userInput?: string;
  readonly skillType?: string | undefined;
  readonly skillPath?: string | undefined;
  readonly skillSource?: SkillSource | undefined;
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string | undefined;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
  readonly ownerPromptId?: string;
  readonly disclosure?: unknown;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export interface ExternalClientOrigin extends ExternalClientSessionMeta {
  readonly kind: 'external_client';
}

export interface ExternalRecordOrigin extends ExternalClientSessionMeta {
  readonly kind: 'external_record';
  readonly recordId: string;
  readonly recordKind: 'note' | 'user_excerpt' | 'assistant_excerpt' | 'handoff';
  readonly title?: string;
}

export interface TaskOrigin {
  readonly kind: 'task';
  readonly taskId: string;
  readonly status: AgentTaskStatus;
  readonly notificationId: string;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly deliveryMode?: import('@kiki/protocol').CronDeliveryMode;
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly coalescedCount: number;
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  readonly count: number;
}

export interface HookResultOrigin {
  readonly kind: 'hook_result';
  readonly event: string;
  readonly blocked?: boolean;
}

export interface RetryOrigin {
  readonly kind: 'retry';
  readonly trigger?: string;
}

export interface PeerThreadOrigin {
  readonly kind: 'peer_thread';
  readonly source: ThreadRef;
  readonly messageId: string;
  readonly acceptedAt: number;
}

export interface BridgedPeerOrigin extends BridgedThreadMetadata {
  readonly kind: 'bridged_peer';
  readonly messageId: string;
  readonly acceptedAt: number;
}

export interface AgentMessageOrigin {
  readonly kind: 'agent_message';
  readonly messageId: string;
  readonly senderAgentId: string;
  readonly senderTaskName: string;
}

export interface PersonaGreetingOrigin {
  readonly kind: 'persona_greeting';
  readonly personaId: string;
}

export interface RoomMessageOrigin {
  readonly kind: 'room_message';
  readonly roomId: string;
  readonly messageId: string;
  readonly targeted: boolean;
  readonly generation?: number;
}

export interface MergedPromptOrigin {
  readonly kind: 'merged';
  readonly origins: readonly PromptOrigin[];
}

export interface UnknownPromptOrigin { readonly kind: 'unknown' }

export interface ExternalThreadOrigin {
  readonly kind: 'external_thread';
  readonly messageId: string;
  readonly acceptedAt: number;
}

export type PromptOrigin =
  | MergedPromptOrigin
  | UnknownPromptOrigin
  | ExternalThreadOrigin
  | UserPromptOrigin
  | SkillActivationOrigin
  | PluginCommandOrigin
  | InjectionOrigin
  | ShellCommandOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | ExternalClientOrigin
  | ExternalRecordOrigin
  | TaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin
  | PeerThreadOrigin
  | BridgedPeerOrigin
  | AgentMessageOrigin
  | PersonaGreetingOrigin
  | RoomMessageOrigin;

export interface ContextMessageSource {
  readonly ref?: string;
  readonly turnId?: number;
  readonly stepId?: string;
  readonly step?: number;
  readonly frameId?: string;
  readonly toolCallId?: string;
}

export type ContextMessage = Message & {
  readonly id?: string;
  readonly providerMessageId?: string;
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  readonly note?: string;
  readonly fileRead?: import('#/agent/agentsMdReminder/instructionCoverage').FileReadDisclosure;
  readonly memoryReceipt?: import('#/tool/toolContract').MemoryWriteReceipt;
  readonly source?: ContextMessageSource;
  readonly toolCallSources?: Readonly<Record<string, ContextMessageSource>>;
};

export interface UserMessageRecord {
  content: readonly ContentPart[];
  origin: PromptOrigin;
}

export interface SystemReminderRecord {
  content: string;
  origin: PromptOrigin;
}

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}
