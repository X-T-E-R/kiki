/**
 * Schema-free event source bindings shared by both validated (`klient.ts`) and
 * unvalidated (`klient-lite.ts`) hubs. Contract modules attach Zod schemas to
 * these exact entries so source routing stays single-source-of-truth.
 */

export type EventSourceDescriptor =
  | { readonly kind: 'bus'; readonly type: string }
  | { readonly kind: 'emitter'; readonly service: string; readonly event: string }
  | { readonly kind: 'stream'; readonly name: string; readonly type?: string };

export const globalEventDescriptors = {
  'usage.settled': { kind: 'bus', type: 'event.usage.settled' },
  'room.changed': { kind: 'emitter', service: 'roomService', event: 'onDidChange' },
  'thread.messageDelivery': { kind: 'emitter', service: 'threadCommunicationService', event: 'onDidChangeMessageDelivery' },
  'connections.changed': { kind: 'bus', type: 'event.remote_connections.changed' },
  'remoteConnections.changed': { kind: 'bus', type: 'event.remote_connections.changed' },
  'portableSpaces.changed': { kind: 'bus', type: 'event.portable_spaces.changed' },
  'search.indexStateChanged': { kind: 'bus', type: 'event.search.index_state_changed' },
  'executors.antigravityInstallProgress': { kind: 'bus', type: 'event.executor.antigravity_install_progress' },
  'config.changed': { kind: 'emitter', service: 'configService', event: 'onDidChangeConfiguration' },
  'config.sectionChanged': { kind: 'emitter', service: 'configService', event: 'onDidSectionChange' },
  'kosong.providers.changed': { kind: 'emitter', service: 'providerService', event: 'onDidChangeProviders' },
  'kosong.models.changed': { kind: 'emitter', service: 'modelService', event: 'onDidChangeModels' },
  'plugins.reloaded': { kind: 'emitter', service: 'pluginService', event: 'onDidReload' },
  'plugins.changed': { kind: 'bus', type: 'event.plugin.changed' },
  'personas.changed': { kind: 'bus', type: 'event.persona.changed' },
  'session.created': { kind: 'bus', type: 'event.session.created' },
  'session.archived': { kind: 'bus', type: 'event.session.archived' },
  'session.metaUpdated': { kind: 'bus', type: 'session.meta.updated' },
  'session.workChanged': { kind: 'bus', type: 'event.session.work_changed' },
  'kosong.changed': { kind: 'bus', type: 'event.model_catalog.changed' },
} as const satisfies Record<string, EventSourceDescriptor>;

export const sessionEventDescriptors = {
  'execution.changed': { kind: 'emitter', service: 'sessionExecutionControl', event: 'onDidChange' },
  'metadata.changed': { kind: 'emitter', service: 'sessionMetadata', event: 'onDidChangeMetadata' },
  'skills.changed': { kind: 'emitter', service: 'sessionSkillCatalog', event: 'onDidChange' },
  'interactions.changed': { kind: 'stream', name: 'interactions' },
  'interactions.resolved': { kind: 'stream', name: 'interactions:resolved' },
} as const satisfies Record<string, EventSourceDescriptor>;

export const agentEventDescriptors = {
  'prompt.model_switch_queued': { kind: 'stream', name: 'events', type: 'prompt.model_switch_queued' },
  'prompt.model_switch_status': { kind: 'stream', name: 'events', type: 'prompt.model_switch_status' },
  'turn.step.started': { kind: 'stream', name: 'events', type: 'turn.step.started' },
  'turn.step.interrupted': { kind: 'stream', name: 'events', type: 'turn.step.interrupted' },
  'turn.step.retrying': { kind: 'stream', name: 'events', type: 'turn.step.retrying' },
  'hook.result': { kind: 'stream', name: 'events', type: 'hook.result' },
  'goal.updated': { kind: 'stream', name: 'events', type: 'goal.updated' },
  'turn.started': { kind: 'stream', name: 'events', type: 'turn.started' },
  'turn.ended': { kind: 'stream', name: 'events', type: 'turn.ended' },
  'assistant.delta': { kind: 'stream', name: 'events', type: 'assistant.delta' },
  'thinking.delta': { kind: 'stream', name: 'events', type: 'thinking.delta' },
  'tool.call.started': { kind: 'stream', name: 'events', type: 'tool.call.started' },
  'tool.call.delta': { kind: 'stream', name: 'events', type: 'tool.call.delta' },
  'tool.progress': { kind: 'stream', name: 'events', type: 'tool.progress' },
  'tool.result': { kind: 'stream', name: 'events', type: 'tool.result' },
  'prompt.submitted': { kind: 'stream', name: 'events', type: 'prompt.submitted' },
  'prompt.queued': { kind: 'stream', name: 'events', type: 'prompt.queued' },
  'prompt.started': { kind: 'stream', name: 'events', type: 'prompt.started' },
  'prompt.replaced': { kind: 'stream', name: 'events', type: 'prompt.replaced' },
  'prompt.moved': { kind: 'stream', name: 'events', type: 'prompt.moved' },
  'prompt.timing_changed': { kind: 'stream', name: 'events', type: 'prompt.timing_changed' },
  'prompt.steered': { kind: 'stream', name: 'events', type: 'prompt.steered' },
  'prompt.completed': { kind: 'stream', name: 'events', type: 'prompt.completed' },
  'prompt.aborted': { kind: 'stream', name: 'events', type: 'prompt.aborted' },
  'compaction.started': { kind: 'stream', name: 'events', type: 'compaction.started' },
  'compaction.blocked': { kind: 'stream', name: 'events', type: 'compaction.blocked' },
  'compaction.cancelled': { kind: 'stream', name: 'events', type: 'compaction.cancelled' },
  'compaction.completed': { kind: 'stream', name: 'events', type: 'compaction.completed' },
  'permission.approval.requested': { kind: 'stream', name: 'events', type: 'permission.approval.requested' },
  'permission.approval.resolved': { kind: 'stream', name: 'events', type: 'permission.approval.resolved' },
  error: { kind: 'stream', name: 'events', type: 'error' },
  warning: { kind: 'stream', name: 'events', type: 'warning' },
  'agent.status.updated': { kind: 'stream', name: 'events', type: 'agent.status.updated' },
} as const satisfies Record<string, EventSourceDescriptor>;
