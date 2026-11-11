import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { WireRecord } from '#/wire/record';

/** What the source workspace hands the target workspace when a subagent becomes its own thread. */
export interface PromotionSource {
  readonly sourceSessionId: string;
  readonly agentId: string;
  readonly agentMeta: AgentMeta;
  readonly records: readonly WireRecord[];
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly sourceSessionScope: string;
  readonly sourceSessionDir: string;
  readonly sourceMediaDirs: readonly string[];
  readonly sourceTitle?: string;
  readonly sessionCwd: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
}

export interface SettledAgentRecords {
  readonly records: readonly WireRecord[];
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export interface RetargetedRecords {
  readonly records: readonly WireRecord[];
  readonly foreignBlobs: readonly { readonly agentId: string; readonly hash: string }[];
  readonly fileIds: ReadonlySet<string>;
}

const DROPPED_TYPES: ReadonlySet<string> = new Set([
  'forked',
  'runtime.set_binding',
  'profile.bind',
  'profile.dynamic_snapshot',
  'config.update',
  'tools.set_active_tools',
  'tools.reset_active_tools',
  'tools.policy_refreshed',
  'permission.set_mode',
  'executor.session.updated',
  'turn.cancel',
]);

const DROPPED_PREFIXES: readonly string[] = [
  'prompt.',
  'task.',
  'subagent.',
  'cron.',
  'interaction.',
  'permission.approval.',
];

const BLOBREF_PATTERN = /blobref:([A-Za-z0-9][A-Za-z0-9_-]{0,255})[/:]([0-9a-f]{64})/gu;
const FILE_ID_PATTERN = /\bf_[A-Za-z0-9][A-Za-z0-9_-]*/gu;

/**
 * Cuts a subagent journal at a closed boundary. A finished agent keeps everything; an agent that is
 * mid-turn keeps the steps whose tool calls all returned and gets a synthetic cancelled turn end, so
 * the promoted thread never inherits a half-open step or a turn that would resume on its own.
 */
export function sliceSettledAgentRecords(records: readonly WireRecord[]): SettledAgentRecords {
  let lastEnded = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]!.type === 'turn.ended') {
      lastEnded = index;
      break;
    }
  }
  const endedReason = lastEnded === -1 ? undefined : turnOutcome(records[lastEnded]!['reason']);
  let openTurnId: number | undefined;
  let open = false;
  let lastStepEnd = -1;
  let firstStepBegin = -1;
  for (let index = lastEnded + 1; index < records.length; index += 1) {
    const record = records[index]!;
    const event = loopEvent(record);
    if (event !== undefined) {
      open = true;
      openTurnId ??= parseTurnId(event['turnId']);
      if (event['type'] === 'step.begin' && firstStepBegin === -1) firstStepBegin = index;
      if (event['type'] === 'step.end' && event['finishReason'] !== 'error' && event['finishReason'] !== 'interrupted') lastStepEnd = index;
      continue;
    }
    if (record.type === 'turn.prompt' || record.type === 'turn.steer') {
      open = true;
      openTurnId ??= typeof record['turnId'] === 'number' ? record['turnId'] : undefined;
      continue;
    }
    if (record.type === 'context.append_message' && messageRole(record) === 'user') open = true;
  }
  if (!open) return { records, lastTurnReason: endedReason };
  const cut = lastStepEnd !== -1 ? lastStepEnd + 1 : firstStepBegin !== -1 ? firstStepBegin : records.length;
  const kept = records.slice(0, cut);
  const time = latestTime(kept) ?? Date.now();
  return {
    records: [...kept, { type: 'turn.ended', turnId: openTurnId ?? nextTurnId(kept), reason: 'cancelled', time }],
    lastTurnReason: 'cancelled',
  };
}

/**
 * Removes records that belong to the source session's runtime rather than the conversation: the
 * subagent's binding and tool activation (the promoted main binds fresh), queued or unsettled prompt
 * bookkeeping, background tasks and nested subagents that stay with the source, pending interactions,
 * and the remote executor session reference so the new thread can never write into the old one.
 */
export function filterPromotedRecords(records: readonly WireRecord[]): readonly WireRecord[] {
  return records.filter((record) => {
    if (record.type === 'permission.record_approval_result' && record['sessionApprovalRule'] !== undefined) {
      const result = record['result'];
      if (result !== null && typeof result === 'object') {
        const approval = result as Record<string, unknown>;
        if (approval['decision'] === 'approved' && approval['scope'] === 'session') return false;
      }
    }
    return !DROPPED_TYPES.has(record.type) && !DROPPED_PREFIXES.some((prefix) => record.type.startsWith(prefix));
  });
}

/**
 * Points every agent-scoped blob reference at the promoted main agent and moves absolute paths under
 * the source agent home and session media directories onto the target. Returns the blobs that live under
 * other agents (shared screenshots, parent attachments) so the caller can copy them next to the new main
 * agent, and the session media file ids the records mention.
 */
export function retargetPromotedRecords(
  records: readonly WireRecord[],
  sourceAgentId: string,
  sourceAgentHome: string,
  targetAgentHome: string,
  sourceMediaDirs: readonly string[],
  targetMediaDir: string,
): RetargetedRecords {
  const foreign = new Map<string, { agentId: string; hash: string }>();
  const fileIds = new Set<string>();
  const homeVariants = [
    ...pathVariants(sourceAgentHome, targetAgentHome),
    ...sourceMediaDirs.flatMap((sourceMediaDir) => pathVariants(sourceMediaDir, targetMediaDir)),
  ];
  const retargeted = records.map((record) => {
    let text = JSON.stringify(record);
    let changed = false;
    if (text.includes('blobref:')) {
      text = text.replace(BLOBREF_PATTERN, (_match, agentId: string, hash: string) => {
        if (agentId !== sourceAgentId && agentId !== 'main') foreign.set(`${agentId}:${hash}`, { agentId, hash });
        else if (agentId === 'main' && sourceAgentId !== 'main') foreign.set(`main:${hash}`, { agentId, hash });
        changed = true;
        return `blobref:main:${hash}`;
      });
    }
    for (const [from, to] of homeVariants) {
      if (!text.includes(from)) continue;
      const next = text.replace(new RegExp(`${escapeRegExp(from)}(?=[/\\\\"])`, 'gu'), to);
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
    for (const match of text.matchAll(FILE_ID_PATTERN)) fileIds.add(match[0]);
    return changed ? JSON.parse(text) as WireRecord : record;
  });
  return { records: retargeted, foreignBlobs: [...foreign.values()], fileIds };
}

function pathVariants(from: string, to: string): readonly (readonly [string, string])[] {
  const forwardFrom = from.replaceAll('\\', '/');
  const forwardTo = to.replaceAll('\\', '/');
  const escapedBackFrom = forwardFrom.replaceAll('/', '\\\\');
  const escapedBackTo = forwardTo.replaceAll('/', '\\\\');
  return [[forwardFrom, forwardTo], [escapedBackFrom, escapedBackTo]];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function loopEvent(record: WireRecord): Record<string, unknown> | undefined {
  if (record.type !== 'context.append_loop_event') return undefined;
  const event = record['event'];
  return event !== null && typeof event === 'object' && !Array.isArray(event)
    ? event as Record<string, unknown>
    : undefined;
}

function messageRole(record: WireRecord): unknown {
  const message = record['message'];
  return message !== null && typeof message === 'object' ? (message as Record<string, unknown>)['role'] : undefined;
}

function parseTurnId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function turnOutcome(value: unknown): 'completed' | 'cancelled' | 'failed' | undefined {
  if (value === 'blocked') return 'failed';
  return value === 'completed' || value === 'cancelled' || value === 'failed' ? value : undefined;
}

function nextTurnId(records: readonly WireRecord[]): number {
  let next = 0;
  for (const record of records) {
    const direct = record.type === 'turn.prompt' || record.type === 'turn.steer' || record.type === 'turn.ended'
      ? parseTurnId(record['turnId'])
      : undefined;
    const id = direct ?? parseTurnId(loopEvent(record)?.['turnId']);
    if (id !== undefined) next = Math.max(next, id + 1);
  }
  return next;
}

function latestTime(records: readonly WireRecord[]): number | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const time = records[index]!.time;
    if (typeof time === 'number' && Number.isFinite(time)) return time;
  }
  return undefined;
}
