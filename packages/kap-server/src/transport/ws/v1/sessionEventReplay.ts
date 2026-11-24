import { gradeFor, type TranscriptGradeSpec } from '@kiki/transcript';
import {
  encodeJsonValueBounded,
  MAX_SINGLE_JOURNAL_LINE_BYTES,
} from './boundedJsonEncoder';
import {
  type EventEnvelope,
  extractEnvelopeRouting,
  isRosterHintEventType,
  type JournalGapEntry,
  type JournalGapReason,
  type JournalRecord,
  type JournalRosterHint,
} from './sessionEventJournal';
import type { Event } from './events';

/** Bounded tail entry retained in memory for a live session (never holds raw oversized objects). */
export type SessionTailEntry =
  | {
      readonly kind: 'event';
      readonly seq: number;
      readonly attentionSeq: number;
      readonly bytes: number;
      readonly encoded: Buffer;
      readonly eventType: string;
      readonly agentId: string | null;
      readonly epoch?: string;
      readonly sessionId?: string;
      readonly rosterHint?: JournalRosterHint;
    }
  | {
      readonly kind: 'gap';
      readonly seq: number;
      readonly fromSeq?: number;
      readonly attentionSeq: number;
      readonly bytes: number;
      readonly gap: JournalGapEntry;
    };

/** One contiguous step validated over `(cursor.seq, currentSeq]` prior to per-connection filtering. */
export type CoveredReplayItem =
  | {
      readonly kind: 'tail_event';
      readonly seq: number;
      readonly encoded: Buffer;
      readonly eventType: string;
      readonly agentId: string | null;
      readonly epoch?: string;
      readonly sessionId?: string;
      readonly rosterHint?: JournalRosterHint;
    }
  | {
      readonly kind: 'disk_event';
      readonly seq: number;
      readonly envelope: EventEnvelope;
    }
  | {
      readonly kind: 'gap';
      readonly gap: JournalGapEntry;
    };

/** Minimal metadata used to evaluate connection visibility identically for events and gaps. */
export interface VisibilitySubject {
  readonly eventType: string;
  readonly agentId: string | null;
  readonly routingKnown: boolean;
}

/** Whether a type is globally broadcast to all connections regardless of session/agent filter. */
export function isGlobalEventType(type: string): boolean {
  return (
    type === 'session.meta.updated' ||
    type === 'session.worktree.changed' ||
    type.startsWith('event.session.') ||
    type.startsWith('event.workspace.') ||
    type.startsWith('event.config.') ||
    (type.startsWith('event.plugin.') && type !== 'event.plugin.topic') ||
    type.startsWith('event.persona.') ||
    type.startsWith('event.capability.') ||
    type.startsWith('event.model_catalog.') ||
    type.startsWith('event.remote_connections.')
  );
}

/** Whether a type is an agent lifecycle event that bypasses agent allowlist and transcript suppression. */
export function isAgentLifecycleEventType(type: string): boolean {
  return (
    type === 'agent.created' ||
    type === 'agent.disposed' ||
    type === 'agent.branch_sealed' ||
    type === 'agent.tool_lock_changed'
  );
}

/** Event types projected onto the v2 transcript stream and suppressed on subscribed connections. */
export const TRANSCRIPT_PROJECTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.ended',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.interrupted',
  'turn.step.retrying',
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.call.started',
  'tool.progress',
  'tool.result',
  'shell.started',
  'shell.output',
  'shell.completed',
  'task.started',
  'task.terminated',
  'background.task.started',
  'background.task.terminated',
  'task.notified',
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.suspended',
  'compaction.started',
  'compaction.blocked',
  'compaction.cancelled',
  'compaction.completed',
  'skill.activated',
  'plugin_command.activated',
  'cron.fired',
  'error',
  'warning',
  'goal.updated',
  'plan.revision',
  'context.spliced',
  'agent.status.updated',
  'hook.result',
  'prompt.submitted',
  'prompt.started',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
  'prompt.steer_accepted',
  'prompt.queued',
  'prompt.queue_hold_changed',
  'prompt.enqueued',
  'prompt.replaced',
  'prompt.timing_changed',
  'prompt.launch_committed',
  'prompt.moved',
  'event.question.requested',
  'event.question.dismissed',
  'event.question.answered',
  'event.approval.requested',
  'event.approval.resolved',
]);

/** Internal event types suppressed on transcript-only connections. */
export const TRANSCRIPT_ONLY_INTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context.append_message',
  'context.append_loop_event',
  'turn.prompt',
  'llm.request',
  'llm.tools_snapshot',
  'profile.dynamic_snapshot',
  'profile.bind',
  'task.restoration_settled',
  'task.settlement_ready',
  'prompt.outcome_committed',
]);

/** Evaluate the connection's legacy agent allowlist for either an event or a gap subject. */
export function subjectMatchesAgentFilter(
  subject: VisibilitySubject,
  filter: ReadonlySet<string> | undefined,
): boolean {
  if (filter === undefined) return true;
  if (!subject.routingKnown) return true;
  if (isGlobalEventType(subject.eventType)) return true;
  if (isAgentLifecycleEventType(subject.eventType)) return true;
  if (
    subject.eventType.startsWith('event.approval.') ||
    subject.eventType.startsWith('event.question.')
  ) {
    return true;
  }
  if (subject.agentId === null) return true;
  return filter.has(subject.agentId);
}

/** Evaluate per-connection transcript suppression identically for events and gaps. */
export function subjectSuppressedByTranscript(
  subject: VisibilitySubject,
  spec: TranscriptGradeSpec | undefined,
  transcriptOnly = false,
  detachedTranscriptAgents?: ReadonlySet<string>,
): boolean {
  if (spec === undefined) return false;
  if (!subject.routingKnown) return false;
  if (isGlobalEventType(subject.eventType)) return false;
  if (isAgentLifecycleEventType(subject.eventType)) return false;
  if (subject.agentId === null) return false;
  const grade = gradeFor(spec, subject.agentId);
  if (grade === 'off') {
    if (!transcriptOnly || detachedTranscriptAgents?.has(subject.agentId) === true) return false;
    if (
      subject.eventType.startsWith('event.approval.') ||
      subject.eventType.startsWith('event.question.')
    ) {
      return false;
    }
    return (
      TRANSCRIPT_PROJECTED_EVENT_TYPES.has(subject.eventType) ||
      TRANSCRIPT_ONLY_INTERNAL_EVENT_TYPES.has(subject.eventType)
    );
  }
  if (TRANSCRIPT_PROJECTED_EVENT_TYPES.has(subject.eventType)) return true;
  return transcriptOnly && TRANSCRIPT_ONLY_INTERNAL_EVENT_TYPES.has(subject.eventType);
}

/**
 * Prove strict, hole-free coverage of `(fromSeqExclusive, currentSeq]` from
 * the in-memory bounded tail, verifying start, interior, end, epoch, and session identity.
 */
export function collectContiguousTailRange(
  tail: readonly SessionTailEntry[],
  fromSeqExclusive: number,
  currentSeq: number,
  epoch: string,
  sessionId: string,
): CoveredReplayItem[] | undefined {
  if (currentSeq <= fromSeqExclusive) return [];
  let expected = fromSeqExclusive + 1;
  const covered: CoveredReplayItem[] = [];

  for (const entry of tail) {
    if (entry.kind === 'event') {
      if (entry.seq <= fromSeqExclusive) continue;
      if (entry.seq > currentSeq) break;
      if (entry.seq !== expected) return undefined;
      if (entry.epoch !== undefined && entry.epoch !== epoch) return undefined;
      if (entry.sessionId !== undefined && entry.sessionId !== sessionId) return undefined;
      covered.push({
        kind: 'tail_event',
        seq: entry.seq,
        encoded: entry.encoded,
        eventType: entry.eventType,
        agentId: entry.agentId,
        epoch: entry.epoch,
        sessionId: entry.sessionId,
        rosterHint: entry.rosterHint,
      });
      expected = entry.seq + 1;
    } else {
      const rangeStart = entry.fromSeq ?? entry.seq;
      const rangeEnd = entry.seq;
      if (rangeEnd <= fromSeqExclusive) continue;
      if (rangeStart > currentSeq) break;
      if (rangeStart > expected) return undefined;
      if (entry.gap.epoch !== undefined && entry.gap.epoch !== epoch) return undefined;
      if (entry.gap.sessionId !== undefined && entry.gap.sessionId !== sessionId) return undefined;
      covered.push({ kind: 'gap', gap: entry.gap });
      expected = Math.min(rangeEnd, currentSeq) + 1;
    }
    if (expected > currentSeq) break;
  }

  return expected === currentSeq + 1 ? covered : undefined;
}

/**
 * Prove strict, hole-free coverage of `(fromSeqExclusive, currentSeq]` from
 * disk journal records, validating start, interior, end, envelope seq, epoch, and session identity.
 */
export function collectContiguousDiskRange(
  records: readonly JournalRecord[],
  fromSeqExclusive: number,
  currentSeq: number,
  epoch: string,
  sessionId: string,
): CoveredReplayItem[] | undefined {
  if (currentSeq <= fromSeqExclusive) return [];
  let expected = fromSeqExclusive + 1;
  const covered: CoveredReplayItem[] = [];

  for (const record of records) {
    if (record.kind === 'event') {
      if (record.seq <= fromSeqExclusive) continue;
      if (record.seq > currentSeq) break;
      if (record.seq !== expected) return undefined;
      if (record.envelope.seq !== record.seq) return undefined;
      if (record.envelope.epoch !== undefined && record.envelope.epoch !== epoch) return undefined;
      if (record.envelope.session_id !== undefined && record.envelope.session_id !== sessionId) {
        return undefined;
      }
      covered.push({
        kind: 'disk_event',
        seq: record.seq,
        envelope: record.envelope,
      });
      expected = record.seq + 1;
    } else {
      const rangeStart = record.fromSeq ?? record.seq;
      const rangeEnd = record.seq;
      if (rangeEnd <= fromSeqExclusive) continue;
      if (rangeStart > currentSeq) break;
      if (rangeStart > expected) return undefined;
      if (record.epoch !== undefined && record.epoch !== epoch) return undefined;
      if (record.sessionId !== undefined && record.sessionId !== sessionId) return undefined;
      covered.push({ kind: 'gap', gap: record });
      expected = Math.min(rangeEnd, currentSeq) + 1;
    }
    if (expected > currentSeq) break;
  }

  return expected === currentSeq + 1 ? covered : undefined;
}

/** Decode one bounded tail `Buffer` back into its `EventEnvelope` on demand. */
export function decodeTailEnvelope(encoded: Buffer): EventEnvelope | undefined {
  try {
    const parsed = JSON.parse(encoded.toString('utf8')) as { kind?: unknown; envelope?: unknown };
    if (parsed.kind !== 'event' || typeof parsed.envelope !== 'object' || parsed.envelope === null) {
      return undefined;
    }
    return parsed.envelope as EventEnvelope;
  } catch {
    return undefined;
  }
}

/** Build a lightweight internal roster-hint envelope from a gap's preserved hint metadata. */
export function buildRosterHintEnvelopeFromGap(
  gap: JournalGapEntry,
  sessionId: string,
  epoch: string,
): EventEnvelope | undefined {
  const hint = gap.rosterHint;
  if (hint === undefined || !hint.required) return undefined;
  const payload: Record<string, unknown> = {
    type: hint.type,
    sessionId,
  };
  if (hint.agentId !== undefined) payload['agentId'] = hint.agentId;
  if (hint.subagentId !== undefined) payload['subagentId'] = hint.subagentId;
  if (hint.infoKind !== undefined) {
    payload['info'] = {
      kind: hint.infoKind,
      ...(hint.infoAgentId !== undefined ? { agentId: hint.infoAgentId } : {}),
    };
  }
  return {
    type: hint.type,
    seq: gap.seq,
    epoch,
    session_id: sessionId,
    timestamp: new Date(0).toISOString(),
    payload,
  };
}

/** Result of per-connection replay visibility evaluation over a proven-contiguous range. */
export type ReplayVisibilityVerdict =
  | {
      readonly ok: true;
      readonly events: Array<{ seq: number; envelope: EventEnvelope }>;
      readonly rosterHints: EventEnvelope[];
    }
  | { readonly ok: false; readonly reason: 'journal_gap' };

/**
 * Evaluate each item in a proven-contiguous replay range for one connection's
 * exact filter, transcript grades, transcriptOnly flag, detached agent set, and
 * roster-hint requirement. Any visible, unfilterable, or unprovable gap fails
 * the entire range with `journal_gap`.
 */
export function judgeReplayVisibility(
  covered: readonly CoveredReplayItem[],
  sessionId: string,
  epoch: string,
  filter: ReadonlySet<string> | undefined,
  transcriptGrades: TranscriptGradeSpec | undefined,
  transcriptOnly: boolean,
  detachedTranscriptAgents: ReadonlySet<string> | undefined,
  wantsRosterHints: boolean,
): ReplayVisibilityVerdict {
  const events: Array<{ seq: number; envelope: EventEnvelope }> = [];
  const rosterHints: EventEnvelope[] = [];

  for (const item of covered) {
    if (item.kind === 'tail_event') {
      const subject: VisibilitySubject = {
        eventType: item.eventType,
        agentId: item.agentId,
        routingKnown: true,
      };
      if (!subjectMatchesAgentFilter(subject, filter)) continue;
      if (subjectSuppressedByTranscript(subject, transcriptGrades, transcriptOnly, detachedTranscriptAgents)) {
        if (wantsRosterHints && item.rosterHint?.required === true) {
          const envelope = decodeTailEnvelope(item.encoded);
          if (envelope === undefined) return { ok: false, reason: 'journal_gap' };
          rosterHints.push(envelope);
        }
        continue;
      }
      const envelope = decodeTailEnvelope(item.encoded);
      if (envelope === undefined) return { ok: false, reason: 'journal_gap' };
      events.push({ seq: item.seq, envelope });
      continue;
    }

    if (item.kind === 'disk_event') {
      const routing = extractEnvelopeRouting(item.envelope);
      const subject: VisibilitySubject = {
        eventType: item.envelope.type,
        agentId: routing.agentId,
        routingKnown: routing.routingKnown,
      };
      if (!subjectMatchesAgentFilter(subject, filter)) continue;
      if (subjectSuppressedByTranscript(subject, transcriptGrades, transcriptOnly, detachedTranscriptAgents)) {
        if (wantsRosterHints && routing.rosterHint?.required === true) {
          rosterHints.push(item.envelope);
        }
        continue;
      }
      events.push({ seq: item.seq, envelope: item.envelope });
      continue;
    }

    const gap = item.gap;
    if (
      !gap.routingKnown ||
      gap.reason === 'queue_backpressure' ||
      gap.reason === 'write_failed'
    ) {
      return { ok: false, reason: 'journal_gap' };
    }
    const subject: VisibilitySubject = {
      eventType: gap.eventType,
      agentId: gap.agentId,
      routingKnown: gap.routingKnown,
    };
    if (!subjectMatchesAgentFilter(subject, filter)) {
      continue;
    }
    if (!subjectSuppressedByTranscript(subject, transcriptGrades, transcriptOnly, detachedTranscriptAgents)) {
      return { ok: false, reason: 'journal_gap' };
    }
    if (isRosterHintEventType(gap.eventType)) {
      if (gap.rosterHint === undefined) {
        return { ok: false, reason: 'journal_gap' };
      }
      if (gap.rosterHint.required && wantsRosterHints) {
        const hintEnvelope = buildRosterHintEnvelopeFromGap(gap, sessionId, epoch);
        if (hintEnvelope === undefined) return { ok: false, reason: 'journal_gap' };
        rosterHints.push(hintEnvelope);
      }
    }
  }

  return { ok: true, events, rosterHints };
}

/** Pre-projected event descriptor admitted into a session dispatch queue without pinning giant payloads. */
export type QueuedDispatchPayload =
  | {
      readonly kind: 'full';
      readonly event: Event;
      readonly estimatedBytes: number;
    }
  | {
      readonly kind: 'oversized_gap';
      readonly trackerEvent: Event;
      readonly eventType: string;
      readonly agentId: string | null;
      readonly routingKnown: boolean;
      readonly omittedBytesAtLeast: number;
      readonly reason: JournalGapReason;
      readonly rosterHint?: JournalRosterHint;
      readonly time?: number;
      readonly estimatedBytes: number;
      readonly liveRawEvent?: Event;
    };

/** Extract only lightweight tracker/roster fields from an event without retaining giant payloads. */
export function buildLightweightTrackerStub(event: Event): Event {
  const rec = event as unknown as Record<string, unknown>;
  const stub: Record<string, unknown> = {
    type: event.type,
    agentId: event.agentId,
    sessionId: event.sessionId,
  };
  if (event.time !== undefined) stub['time'] = event.time;
  if (typeof rec['turnId'] === 'number') stub['turnId'] = rec['turnId'];
  if (typeof rec['step'] === 'number') stub['step'] = rec['step'];
  if (typeof rec['stepId'] === 'string') stub['stepId'] = rec['stepId'];
  if (typeof rec['toolCallId'] === 'string') stub['toolCallId'] = rec['toolCallId'];
  if (typeof rec['name'] === 'string') stub['name'] = rec['name'];
  if (typeof rec['subagentId'] === 'string') stub['subagentId'] = rec['subagentId'];
  if (typeof rec['taskId'] === 'string') stub['taskId'] = rec['taskId'];
  if (typeof rec['parentToolCallId'] === 'string') stub['parentToolCallId'] = rec['parentToolCallId'];
  if (typeof rec['status'] === 'string') stub['status'] = rec['status'];
  if (typeof rec['reason'] === 'string') stub['reason'] = rec['reason'];
  if (typeof rec['info'] === 'object' && rec['info'] !== null) {
    const info = rec['info'] as Record<string, unknown>;
    stub['info'] = {
      ...(typeof info['taskId'] === 'string' ? { taskId: info['taskId'] } : {}),
      ...(typeof info['kind'] === 'string' ? { kind: info['kind'] } : {}),
      ...(typeof info['agentId'] === 'string' ? { agentId: info['agentId'] } : {}),
      ...(typeof info['status'] === 'string' ? { status: info['status'] } : {}),
      ...(typeof info['detached'] === 'boolean' ? { detached: info['detached'] } : {}),
    };
  }
  return stub as unknown as Event;
}

/** Extract only the bounded loop-event metadata required by `InFlightTurnTracker`. */
export function buildLightweightLoopEventStub(event: Event): Event | undefined {
  if (event.type !== 'context.append_loop_event') return undefined;
  const loop = event.event as unknown as Record<string, unknown> | undefined;
  if (typeof loop !== 'object' || loop === null) return undefined;
  const loopType = loop['type'];
  if (loopType === 'step.begin') {
    return {
      type: 'context.append_loop_event',
      agentId: event.agentId,
      sessionId: event.sessionId,
      event: {
        type: 'step.begin',
        turnId: loop['turnId'],
        step: loop['step'],
        uuid: loop['uuid'],
      },
    } as unknown as Event;
  }
  if (loopType === 'content.part') {
    const part = loop['part'] as { readonly type?: unknown } | undefined;
    if (part?.type !== 'text' && part?.type !== 'think') return undefined;
    return {
      type: 'context.append_loop_event',
      agentId: event.agentId,
      sessionId: event.sessionId,
      event: {
        type: 'content.part',
        turnId: loop['turnId'],
        stepUuid: loop['stepUuid'],
        part: { type: part.type },
      },
    } as unknown as Event;
  }
  if (loopType === 'tool.call') {
    const argsProbe = encodeJsonValueBounded(loop['args'], 8192);
    return {
      type: 'context.append_loop_event',
      agentId: event.agentId,
      sessionId: event.sessionId,
      event: {
        type: 'tool.call',
        turnId: loop['turnId'],
        toolCallId: loop['toolCallId'],
        name: loop['name'],
        ...(argsProbe.ok ? { args: loop['args'] } : {}),
      },
    } as unknown as Event;
  }
  if (loopType === 'tool.result') {
    return {
      type: 'context.append_loop_event',
      agentId: event.agentId,
      sessionId: event.sessionId,
      event: {
        type: 'tool.result',
        toolCallId: loop['toolCallId'],
      },
    } as unknown as Event;
  }
  return undefined;
}

/**
 * Measure and pre-project an event prior to queuing so oversized payloads are
 * converted into tiny gap descriptors immediately without pinning giant objects
 * in asynchronous session queues.
 */
export function preProjectEventForQueue(
  event: Event,
  volatile: boolean,
  maxJournalLineBytes = MAX_SINGLE_JOURNAL_LINE_BYTES,
): QueuedDispatchPayload {
  const probeLimit = Math.max(64, maxJournalLineBytes - 192);
  const probe = encodeJsonValueBounded(event, probeLimit);
  if (probe.ok) {
    return {
      kind: 'full',
      event,
      estimatedBytes: probe.bytes,
    };
  }
  if (volatile) {
    return {
      kind: 'full',
      event,
      estimatedBytes: probe.reason === 'exceeded' ? probe.omittedBytesAtLeast : maxJournalLineBytes,
    };
  }
  const routing = extractEnvelopeRouting({
    type: event.type,
    seq: 0,
    session_id: event.sessionId,
    timestamp: '',
    payload: event,
  });
  const reason: JournalGapReason =
    probe.reason === 'invalid'
      ? 'unserializable'
      : TRANSCRIPT_PROJECTED_EVENT_TYPES.has(event.type) ||
          TRANSCRIPT_ONLY_INTERNAL_EVENT_TYPES.has(event.type)
        ? 'transcript_projected_oversize'
        : 'payload_too_large';
  return {
    kind: 'oversized_gap',
    trackerEvent: buildLightweightTrackerStub(event),
    eventType: event.type,
    agentId: routing.agentId,
    routingKnown: routing.routingKnown,
    omittedBytesAtLeast: probe.reason === 'exceeded' ? probe.omittedBytesAtLeast : 0,
    reason,
    ...(routing.rosterHint !== undefined ? { rosterHint: routing.rosterHint } : {}),
    ...(event.time !== undefined ? { time: event.time } : {}),
    estimatedBytes: 256,
  };
}
