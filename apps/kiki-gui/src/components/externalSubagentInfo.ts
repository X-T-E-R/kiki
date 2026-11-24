import type { ToolBlock } from '@kiki/session-core/session';

export interface ExternalSubagentChild {
  readonly id?: string;
  readonly role: string;
  readonly status?: string;
  readonly prompt?: string;
  readonly latestStep?: string;
}

export interface ExternalSubagentSnapshot {
  readonly role: string;
  readonly prompt?: string;
  readonly latestStep?: string;
  readonly status?: string;
  readonly children: readonly ExternalSubagentChild[];
  readonly incomplete?: boolean;
}

const SUBAGENT_TOOL_NAME_RE = /\b(invoke_subagent|start_subagent)\b/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function parseChild(raw: unknown): ExternalSubagentChild | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const role = firstString(record, ['role', 'subagent_role', 'agent_role', 'agent_name', 'name', 'id']);
  if (role === undefined) return undefined;
  return {
    id: firstString(record, ['id', 'subagent_id', 'agent_id']),
    role,
    status: firstString(record, ['status', 'state']),
    prompt: firstString(record, ['prompt', 'task', 'task_prompt', 'description']),
    latestStep: firstString(record, ['latestStep', 'latest_step', 'latestActivity', 'latest_activity', 'activity', 'summary']),
  };
}

function unwrapExternalRawOutput(output: unknown): Record<string, unknown> | undefined {
  const record = asRecord(output);
  if (record === undefined) return undefined;
  if (record['kind'] === 'external_tool_output') {
    return asRecord(record['rawOutput']) ?? asRecord(record['rawInput']) ?? record;
  }
  return record;
}

/**
 * Extracts enriched role, prompt, latest step, and detached child snapshots from
 * external ACP `invoke_subagent` / `start_subagent` tool calls.
 */
export function extractExternalSubagentSnapshot(block: ToolBlock): ExternalSubagentSnapshot | undefined {
  if (!block.toolCallId.startsWith('external:')) return undefined;
  const display = block.display;
  const displayDetail = display?.kind === 'generic' ? asRecord(display.detail) : undefined;
  const args = asRecord(block.args);
  const rawOut = unwrapExternalRawOutput(block.output);

  const isSubagentTool = SUBAGENT_TOOL_NAME_RE.test(block.name)
    || display?.kind === 'agent_call'
    || displayDetail?.['subagent'] !== undefined
    || displayDetail?.['subagents'] !== undefined
    || rawOut?.['subagent'] !== undefined
    || rawOut?.['subagents'] !== undefined;
  if (!isSubagentTool) return undefined;

  const nestedSubagent = asRecord(displayDetail?.['subagent']) ?? asRecord(rawOut?.['subagent']);
  const rawChildren = Array.isArray(displayDetail?.['subagents'])
    ? displayDetail['subagents']
    : Array.isArray(rawOut?.['subagents'])
      ? rawOut['subagents']
      : Array.isArray(displayDetail?.['children'])
        ? displayDetail['children']
        : Array.isArray(rawOut?.['children'])
          ? rawOut['children']
          : [];
  const children = rawChildren.map(parseChild).filter((item): item is ExternalSubagentChild => item !== undefined);

  const role = (display?.kind === 'agent_call' ? display.agent_name : undefined)
    ?? firstString(nestedSubagent, ['role', 'subagent_role', 'agent_role', 'name'])
    ?? firstString(displayDetail, ['role', 'subagent_role', 'agent_role', 'agent_name'])
    ?? firstString(rawOut, ['role', 'subagent_role', 'agent_role', 'agent_name'])
    ?? firstString(args, ['role', 'subagent_role', 'agent_role', 'subagent', 'SubagentName', 'agent_name', 'name'])
    ?? children[0]?.role;

  const prompt = (display?.kind === 'agent_call' ? display.prompt : undefined)
    ?? firstString(nestedSubagent, ['prompt', 'task', 'task_prompt', 'description'])
    ?? firstString(displayDetail, ['prompt', 'task', 'task_prompt', 'description'])
    ?? firstString(rawOut, ['prompt', 'task', 'task_prompt'])
    ?? firstString(args, ['prompt', 'task', 'Task', 'Prompt', 'description', 'instruction'])
    ?? children[0]?.prompt;

  const latestStep = firstString(nestedSubagent, ['latestStep', 'latest_step', 'latestActivity', 'latest_activity', 'activity'])
    ?? firstString(displayDetail, ['latestStep', 'latest_step', 'latestActivity', 'latest_activity', 'activity'])
    ?? firstString(rawOut, ['latestStep', 'latest_step', 'latestActivity', 'latest_activity', 'activity'])
    ?? children.find((child) => child.latestStep !== undefined)?.latestStep
    ?? (block.progressText?.trim() || undefined);

  const status = firstString(nestedSubagent, ['status', 'state'])
    ?? firstString(displayDetail, ['status', 'state'])
    ?? firstString(rawOut, ['status', 'state'])
    ?? children[0]?.status;

  const incomplete = displayDetail?.['incomplete'] === true || rawOut?.['incomplete'] === true || nestedSubagent?.['incomplete'] === true;

  if (role === undefined && latestStep === undefined && children.length === 0) return undefined;
  return {
    role: role ?? block.name,
    prompt,
    latestStep,
    status,
    children,
    incomplete: incomplete ? true : undefined,
  };
}
