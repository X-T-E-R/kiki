import type { ModelSteeringSource } from '@kiki/protocol';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export type SteeringInputSource = 'user' | ModelSteeringSource;

export function steeringInputSource(origin: PromptOrigin | undefined): SteeringInputSource | undefined {
  switch (origin?.kind) {
    case 'user': return 'user';
    case 'plugin_command': return origin.trigger === 'user-slash' ? 'user' : undefined;
    case 'skill_activation': return origin.trigger === 'user-slash' ? 'user' : 'skill';
    case 'peer_thread':
    case 'bridged_peer': return 'thread';
    case 'room_message': return 'room';
    case 'agent_message': return 'agent';
    case 'task': return 'task';
    case 'cron_job':
    case 'cron_missed': return 'cron';
    case 'hook_result': return 'hook';
    case 'system_trigger': return origin.name === 'subagent' ? 'agent' : origin.name === 'thread_create' ? 'thread' : origin.name === 'stop_hook' ? 'hook' : origin.name === 'goal_continuation' ? 'automation' : undefined;
    case 'external_thread':
    case 'external_client':
    case 'external_record': return 'external';
    default: return undefined;
  }
}

export function steeringInputSources(origin: PromptOrigin | undefined): Set<SteeringInputSource> {
  const sources = new Set<SteeringInputSource>();
  const pending = [origin];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next?.kind === 'merged') { pending.push(...next.origins); continue; }
    const source = steeringInputSource(next);
    if (source !== undefined) sources.add(source);
  }
  return sources;
}
