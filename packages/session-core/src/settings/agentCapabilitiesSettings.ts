import {
  AGENT_LIST_TELEMETRY_FIELDS,
  DEFAULT_AGENT_LIST_TELEMETRY_FIELDS,
  type AgentListTelemetryField,
} from '@kiki/protocol';
import type { BoardReadInput } from '@kiki/klient/contract/board/types';
import { configObjectOrEmpty } from './settings';

export {
  AGENT_LIST_TELEMETRY_FIELDS,
  DEFAULT_AGENT_LIST_TELEMETRY_FIELDS,
  type AgentListTelemetryField,
} from '@kiki/protocol';

export const AGENT_LIST_UI_FIELD_ORDER: readonly AgentListTelemetryField[] = [
  'model',
  'elapsed_ms',
  'idle_ms',
  'tool_call_count',
  'thinking_effort',
  'context_tokens',
];

const AGENT_LIST_FIELD_SET = new Set<string>(AGENT_LIST_TELEMETRY_FIELDS);
const DEFAULT_AGENT_LIST_FIELD_SET = new Set<string>(DEFAULT_AGENT_LIST_TELEMETRY_FIELDS);

export type TaskBoardStorage = NonNullable<Extract<BoardReadInput, { action: 'preview' }>['configuration']>;

export function taskBoardStorageFromConfig(value: unknown): TaskBoardStorage {
  const storage = configObjectOrEmpty(configObjectOrEmpty(configObjectOrEmpty(value)['task_board'])['storage']);
  if (storage['mode'] === 'global') return { mode: 'global' };
  if (storage['mode'] === 'fixed' && typeof storage['path'] === 'string') return { mode: 'fixed', path: storage['path'] };
  return { mode: 'auto' };
}

export function subagentLimitsFromConfig(value: unknown): { timeoutMs: number; maxDirectChildren: number; maxTotalSubagents: number } {
  const section = configObjectOrEmpty(configObjectOrEmpty(value)['subagent']);
  const integer = (key: string, fallback: number) => typeof section[key] === 'number' && Number.isSafeInteger(section[key]) && section[key] >= 0 ? section[key] : fallback;
  return { timeoutMs: integer('timeoutMs', 7_200_000), maxDirectChildren: integer('maxDirectChildren', 16), maxTotalSubagents: integer('maxTotalSubagents', 0) };
}

export function subagentAgentListFieldsFromConfig(value: unknown): {
  readonly fields: readonly AgentListTelemetryField[];
  readonly isCustom: boolean;
} {
  const section = configObjectOrEmpty(configObjectOrEmpty(value)['subagent']);
  const raw = section['agentListFields'] ?? section['agent_list_fields'];
  if (!Array.isArray(raw)) {
    return { fields: [...DEFAULT_AGENT_LIST_TELEMETRY_FIELDS], isCustom: false };
  }
  const seen = new Set<AgentListTelemetryField>();
  for (const item of raw) {
    if (typeof item === 'string' && AGENT_LIST_FIELD_SET.has(item)) {
      seen.add(item as AgentListTelemetryField);
    }
  }
  const fields = AGENT_LIST_TELEMETRY_FIELDS.filter((field) => seen.has(field));
  const isDefault =
    fields.length === DEFAULT_AGENT_LIST_FIELD_SET.size &&
    fields.every((field) => DEFAULT_AGENT_LIST_FIELD_SET.has(field));
  return { fields, isCustom: !isDefault };
}

export function toggleAgentListField(
  current: readonly AgentListTelemetryField[],
  field: AgentListTelemetryField,
): AgentListTelemetryField[] {
  const active = new Set(current);
  if (active.has(field)) active.delete(field);
  else active.add(field);
  return AGENT_LIST_TELEMETRY_FIELDS.filter((candidate) => active.has(candidate));
}

export function subagentAgentListFieldsPatch(
  fields: readonly AgentListTelemetryField[] | null,
): { subagent: { agent_list_fields: AgentListTelemetryField[] | null } } {
  return {
    subagent: {
      agent_list_fields: fields === null ? null : [...fields],
    },
  };
}
