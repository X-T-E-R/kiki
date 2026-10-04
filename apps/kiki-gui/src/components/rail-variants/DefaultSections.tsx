/**
 * The default rail's own sections: the profile head over Now,
 * Needs you as plain rows, the activity feed, and capabilities as a folded
 * block of its own. Everything else on the default rail reuses the shared
 * inspector parts (agent-panel/*).
 */

import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';

import { MAIN_AGENT_ID, type AgentForest, type Block, type SessionViewState } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { useConnection, useOptionalControllerRegistry } from '../../state/connection';
import { AgentCapabilitiesSection, capabilityCounts } from '../agent-panel/AgentCapabilitiesSection';
import { AgentDetailDrawer } from '../agent-panel/AgentDetailDrawer';
import { agentTrail } from '../agent-panel/agentRoster';
import { INSPECTOR_HEAD, InspectorChevron } from '../agent-panel/InspectorSection';
import { isCapabilityUnsupportedError, mapPanelSkills, mapPanelSubagentTargets, mapPanelTools } from '../agent-panel/mapCapabilities';
import { capabilitySourceLabel, SOURCE_TONE_CLASS } from '../agent-panel/sourceLabel';
import type { AgentIdentity, DetailDrawerTarget } from '../agent-panel/types';
import { Icon } from '../icons';
import { age, decidable, pendingId, pendingSubject, useNow, type PendingItem } from './model';
import { FOCUS_RING, StateMark, useDecide } from './shell';

const SECTION_HEAD = 'text-[11.5px] font-medium tracking-[0.02em]';
const APPROVE = 'h-7 shrink-0 rounded-md px-2 text-[12px] font-medium text-attention ring-1 ring-attention/45 ring-inset transition-colors hover:bg-attention-soft';
const REJECT = 'h-7 shrink-0 rounded-md px-1.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink';

const SECTION_BUTTON = `group -ml-1.5 flex h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] ${FOCUS_RING}`;

const SHOWN_ROWS = 4;

const noopSubscribe = (): (() => void) => () => {};

/**
 * The focused agent's own view state from the session's controller registry
 * (the same source the agent panel reads), never the routed agent's.
 */
function useAgentState(sessionId: string, agentId: string): SessionViewState | undefined {
  const registry = useOptionalControllerRegistry();
  const subscribeRegistry = useCallback(
    (listener: () => void) => (registry === null ? noopSubscribe() : registry.subscribe(listener)),
    [registry],
  );
  const generation = useSyncExternalStore(subscribeRegistry, () => registry?.snapshot() ?? 0, () => 0);
  const controller = useMemo(() => {
    if (registry === null) return undefined;
    for (const candidate of registry) if (candidate.sessionId === sessionId) return candidate;
    return undefined;
  }, [registry, generation, sessionId]);
  const subscribe = useCallback(
    (listener: () => void) => controller === undefined
      ? noopSubscribe()
      : agentId === MAIN_AGENT_ID ? controller.subscribe(listener) : controller.subscribeAgent(agentId, listener),
    [controller, agentId],
  );
  const read = useCallback(
    () => controller === undefined ? undefined : agentId === MAIN_AGENT_ID ? controller.getState() : controller.getAgentState(agentId),
    [controller, agentId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Done items fold to one line once there are at least this many. */
const FOLD_DONE_AT = 2;

/**
 * 待办: the agent's checklist. Open items always show; finished ones fold to
 * a single 已完成 N 项 line (when there are two or more) that opens them in
 * place. Read-only: the agent writes its list.
 */
export function RailTodos({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const { t } = useI18n();
  const todos = (useAgentState(sessionId, agentId)?.todos ?? []).filter((todo) =>
    todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'done');
  const [open, setOpen] = useState(true);
  const [showDone, setShowDone] = useState(false);
  if (todos.length === 0) return null;
  const doneCount = todos.filter((todo) => todo.status === 'done').length;
  const foldDone = doneCount >= FOLD_DONE_AT && !showDone;
  const rows = foldDone ? todos.filter((todo) => todo.status !== 'done') : todos;
  return (
    <section data-rail-todos="">
      <button type="button" aria-expanded={open} onClick={() => { setOpen((v) => !v); }} className={SECTION_BUTTON}>
        <span className={`${INSPECTOR_HEAD} transition-colors group-hover:text-ink`}>{t('inspector.todos')}</span>
        <span className="text-[12px] text-ink-faint tabular-nums">{doneCount}/{todos.length}</span>
        <span className="flex-1" />
        <InspectorChevron open={open} />
      </button>
      {open ? (
        <ul className="max-h-44 space-y-1 overflow-y-auto pt-1 pr-0.5">
          {doneCount >= FOLD_DONE_AT ? (
            <li>
              <button
                type="button"
                data-rail-todos-done-toggle=""
                aria-expanded={showDone}
                onClick={() => { setShowDone((v) => !v); }}
                className={`-ml-1.5 flex h-7 w-[calc(100%+0.375rem)] items-center gap-2 rounded-md pl-1.5 text-left text-[12.5px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink ${FOCUS_RING}`}
              >
                <span aria-hidden className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] bg-ink/[0.08] text-ink-soft"><Icon name="check" size={12} /></span>
                <span className="flex-1">{showDone ? t('rail.todos.hideDone') : t('rail.todos.doneCount', { count: doneCount })}</span>
                <InspectorChevron open={showDone} />
              </button>
            </li>
          ) : null}
          {rows.map((todo, index) => (
            <li key={`${index}:${todo.title}`} data-rail-todo={todo.status} className="flex items-start gap-2 py-0.5">
              <span
                aria-hidden
                className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${
                  todo.status === 'done'
                    ? 'border-transparent bg-ink/[0.08] text-ink-soft'
                    : todo.status === 'in_progress' ? 'border-ink-soft text-ink-soft' : 'border-hairline-strong bg-panel'
                }`}
              >
                {todo.status === 'done' ? <Icon name="check" size={12} /> : todo.status === 'in_progress' ? <Icon name="dot" size={12} /> : null}
              </span>
              <span className={`text-[13px] leading-snug break-words ${
                todo.status === 'done' ? 'text-ink-faint line-through' : todo.status === 'in_progress' ? 'font-medium text-ink' : 'text-ink-soft'
              }`}>
                <span className="sr-only">{t(todo.status === 'done' ? 'rail.todo.srDone' : todo.status === 'in_progress' ? 'rail.todo.srInProgress' : 'rail.todo.srPending')}</span>
                {todo.title}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Needs you as plain rows, oldest first: a dot, who asked and when, the
 * object in one mono line, text controls at the end. The full card lives in
 * the composer tray; 查看 focuses it. Beyond four rows the rest fold.
 */
export const NeedsYouList = memo(function NeedsYouList({
  items,
  forest,
  onResolveApproval,
  onReview,
  onInspect,
}: {
  items: readonly PendingItem[];
  forest: AgentForest;
  onResolveApproval?: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onReview?: (kind: 'approval' | 'question', id: string) => void;
  onInspect: (agentId: string) => void;
}) {
  const { t, locale } = useI18n();
  const now = useNow();
  const { sending, decide, canDecide } = useDecide(onResolveApproval);
  const [showAll, setShowAll] = useState(false);
  const ordered = useMemo(
    () => items.toSorted((l, r) => Date.parse(l.request.created_at) - Date.parse(r.request.created_at)),
    [items],
  );
  if (ordered.length === 0) return null;
  const shown = showAll || ordered.length <= SHOWN_ROWS + 1 ? ordered : ordered.slice(0, SHOWN_ROWS);
  const hidden = ordered.length - shown.length;
  return (
    <section data-inspector-needs-you="" aria-label={t('inspector.needsYou')}>
      <h3 className="flex h-7 items-center gap-1.5">
        <span className={`${SECTION_HEAD} text-attention`}>{t('inspector.needsYou')}</span>
        <span className="text-[12px] font-medium text-attention tabular-nums">{ordered.length}</span>
      </h3>
      <ul className="border-l-2 border-attention pl-3">
        {shown.map((item) => {
          const id = pendingId(item);
          const origin = item.originUnknown === true ? undefined : item.originAgentId;
          const node = origin !== undefined && origin !== MAIN_AGENT_ID ? forest.byId[origin] : undefined;
          const trail = node !== undefined ? [...agentTrail(forest, node.agentId), node.label].join(' › ') : t('rail.ownerMain');
          const busy = sending.has(id);
          return (
            <li key={id} data-needs-you-item={id} className="flex min-w-0 items-center gap-2 py-1.5">
              <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-attention" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5 leading-5">
                  {node !== undefined ? (
                    <button type="button" data-needs-you-from={node.agentId} title={trail} onClick={() => { onInspect(node.agentId); }} className={`min-w-0 truncate rounded text-[13px] text-ink hover:underline ${FOCUS_RING}`}>{node.label}</button>
                  ) : <span className="text-[13px] text-ink">{t('rail.ownerMain')}</span>}
                  <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">{age(now - Date.parse(item.request.created_at), locale)}</span>
                </span>
                <span className="block truncate font-mono text-[11.5px] leading-[18px] text-ink-faint" title={pendingSubject(item)}>
                  {item.kind === 'approval' ? item.request.tool_name : t('rail.questionTag')} {pendingSubject(item)}
                </span>
              </span>
              {decidable(item) && canDecide ? (
                <span className="flex shrink-0 items-center gap-0.5">
                  <button type="button" data-needs-you-approve={id} disabled={busy} onClick={() => { decide(item, 'approved'); }} className={`${APPROVE} disabled:opacity-50 ${FOCUS_RING}`}>{t('inspector.approveInline')}</button>
                  <button type="button" data-needs-you-reject={id} disabled={busy} onClick={() => { decide(item, 'rejected'); }} className={`${REJECT} disabled:opacity-50 ${FOCUS_RING}`}>{t('inspector.rejectInline')}</button>
                </span>
              ) : (
                <button type="button" data-inspector-review={id} onClick={() => { onReview?.(item.kind, id); }} className={`${APPROVE} ${FOCUS_RING}`}>{item.kind === 'question' ? t('inspector.answer') : t('inspector.review')}</button>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <button type="button" onClick={() => { setShowAll(true); }} className={`mt-0.5 h-7 rounded-md px-1.5 text-[12.5px] text-ink-faint hover:text-ink ${FOCUS_RING}`}>{t('rail.needsYou.more', { count: hidden })}</button>
      ) : null}
    </section>
  );
});

/**
 * The page's head: who this agent is, one fact per line (profile name and
 * source, then model · effort). No card; Now follows directly under it. The
 * name opens the profile drawer. Capabilities live in their own block below.
 * Reads the same agent-panel answer as the other slices (same query key).
 */
export function ProfileHead({ sessionId, agentId, label, fallbackModel, workspaceId, cwd }: {
  sessionId: string;
  agentId: string;
  label: string;
  fallbackModel?: string;
  workspaceId?: string;
  cwd?: string;
}) {
  const { t } = useI18n();
  const { klient } = useConnection();
  const [drawer, setDrawer] = useState<DetailDrawerTarget | null>(null);
  const query = { session_id: sessionId, agent_id: agentId };
  const read = useQuery({
    queryKey: ['agentCapabilities', query],
    queryFn: ({ signal }) => klient.global.agentPanel.read(query, { signal }),
    staleTime: 5_000,
    retry: false,
  });
  const tools = useMemo(() => mapPanelTools(read.data?.tools), [read.data?.tools]);
  const skills = useMemo(() => mapPanelSkills(read.data?.skills), [read.data?.skills]);
  const targets = useMemo(() => mapPanelSubagentTargets(read.data?.targets), [read.data?.targets]);
  const profile = read.data?.profile;
  const profileName = profile?.name !== undefined && profile.name !== '' && profile.name !== 'unknown' ? profile.name : undefined;
  const model = profile?.model ?? fallbackModel;
  const modelLine = [model, profile?.thinking_effort !== undefined ? t('subagent.effort', { effort: String(profile.thinking_effort) }) : undefined]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  const source = capabilitySourceLabel(t, { source: profile?.source, sourceFile: profile?.source_file });
  const identity: AgentIdentity = {
    id: agentId, sessionId, profile: profileName ?? '', label, model,
    thinkingEffort: profile?.thinking_effort, status: 'unknown',
    summary: profile?.description, description: profile?.description,
    source: profile?.source, sourceFile: profile?.source_file,
    context: read.data?.context ?? 'live', isMain: agentId === MAIN_AGENT_ID, rawProfile: profile,
  };
  return (
    <div data-rail-profile-head className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-rail-profile-name
          title={profile?.description ?? t('inspector.details')}
          onClick={() => { setDrawer({ kind: 'profile', identity }); }}
          className={`-ml-1 min-w-0 truncate rounded px-1 text-left font-display text-[15px] leading-6 font-semibold tracking-tight text-ink transition-colors hover:text-ink-soft ${FOCUS_RING}`}
        >
          {profileName ?? label}
        </button>
        {source !== undefined ? (
          <span title={source.title} className={`shrink-0 rounded px-1.5 py-px text-[11px] leading-4 ${SOURCE_TONE_CLASS[source.tone]}`}>{source.text}</span>
        ) : null}
      </div>
      {modelLine !== '' ? (
        <p data-rail-profile-model className="truncate text-[12.5px] leading-5 text-ink-faint" title={modelLine}>{modelLine}</p>
      ) : null}
      <AgentDetailDrawer
        target={drawer}
        onClose={() => { setDrawer(null); }}
        subagentTargets={targets}
        toolCapabilities={tools}
        skills={skills}
        dispatchTargets={read.data?.targets}
        draftScope={{ workspace_id: workspaceId, cwd }}
        callerProfile={profileName}
      />
    </div>
  );
}

/** A folding section head in the inspector's style: title, count, one-line summary while closed. */
export function FoldHead({ title, count, summary, open, onToggle, id }: {
  title: string;
  count?: number;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  id?: string;
}) {
  return (
    <button type="button" id={id} aria-expanded={open} onClick={onToggle} className={SECTION_BUTTON}>
      <span className={`${INSPECTOR_HEAD} transition-colors group-hover:text-ink`}>{title}</span>
      {count !== undefined ? <span className="text-[12px] text-ink-faint tabular-nums">{count}</span> : null}
      {!open && summary !== undefined ? <span className="min-w-0 flex-1 truncate text-right text-[12px] text-ink-faint">{summary}</span> : <span className="flex-1" />}
      <InspectorChevron open={open} />
    </button>
  );
}

type FeedEntry =
  | { kind: 'file'; key: string; at: number; path: string; op: 'read' | 'edit' | 'write'; error: boolean }
  | { kind: 'command'; key: string; at: number; command: string; error: boolean }
  | { kind: 'dispatch'; key: string; at: number; agentId: string; label: string }
  | { kind: 'report'; key: string; at: number; agentId: string; label: string; failed: boolean; summary: string | undefined }
  | { kind: 'compaction'; key: string; at: number };

function feedOf(blocks: readonly Block[], forest: AgentForest): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const block of blocks) {
    if (block.kind === 'tool' && block.display !== undefined && block.startedAt !== undefined) {
      const d = block.display;
      const error = block.isError === true || block.status === 'error';
      if ((d.kind === 'file_io' && d.operation !== 'glob' && d.operation !== 'grep') || d.kind === 'diff') {
        out.push({ kind: 'file', key: block.id, at: block.startedAt, path: d.path, op: d.kind === 'diff' || d.operation === 'edit' ? 'edit' : d.operation === 'write' ? 'write' : 'read', error });
      } else if (d.kind === 'command') {
        out.push({ kind: 'command', key: block.id, at: block.startedAt, command: d.command, error });
      }
    } else if (block.kind === 'notice' && block.i18n?.key.startsWith('transcript.marker.compaction') === true && block.createdAt !== undefined) {
      out.push({ kind: 'compaction', key: block.id, at: Date.parse(block.createdAt) });
    }
  }
  for (const node of Object.values(forest.byId)) {
    if (node.agentId === MAIN_AGENT_ID || node.parentAgentId !== MAIN_AGENT_ID) continue;
    const started = node.startedAt === undefined ? NaN : Date.parse(node.startedAt);
    const ended = node.endedAt === undefined ? NaN : Date.parse(node.endedAt);
    if (Number.isFinite(started)) out.push({ kind: 'dispatch', key: `d:${node.agentId}`, at: started, agentId: node.agentId, label: node.label });
    if (Number.isFinite(ended) && (node.status === 'completed' || node.status === 'failed')) {
      out.push({ kind: 'report', key: `r:${node.agentId}`, at: ended, agentId: node.agentId, label: node.label, failed: node.status === 'failed', summary: node.summary ?? node.error });
    }
  }
  return out.filter((entry) => Number.isFinite(entry.at)).toSorted((l, r) => r.at - l.at);
}

const FEED_SHOWN = 8;
const FILE_MARK = { read: '·', edit: '~', write: '+' } as const;

/**
 * 动态: one time-ordered stream of what the session did (files, commands,
 * dispatches, reports, compactions). Folded by default to its newest line.
 */
export const ActivityFeed = memo(function ActivityFeed({ blocks, forest, onOpenFile, onOpenAgent }: {
  blocks: readonly Block[];
  forest: AgentForest;
  onOpenFile?: (path: string) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t, locale } = useI18n();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const feed = useMemo(() => feedOf(blocks, forest), [blocks, forest]);
  if (feed.length === 0) return null;
  const shown = all ? feed : feed.slice(0, FEED_SHOWN);
  const line = (entry: FeedEntry): { mark: React.ReactNode; body: React.ReactNode; title: string; onClick?: () => void } => {
    switch (entry.kind) {
      case 'file': {
        const name = entry.path.split(/[\\/]/).filter(Boolean).pop() ?? entry.path;
        return {
          mark: <span className={`font-mono text-[11px] ${entry.error ? 'text-danger' : entry.op === 'read' ? 'text-ink-faint' : 'text-amber-ink'}`}>{FILE_MARK[entry.op]}</span>,
          body: <span className="truncate text-ink">{name}</span>,
          title: entry.path,
          onClick: onOpenFile === undefined ? undefined : () => { onOpenFile(entry.path); },
        };
      }
      case 'command':
        return { mark: <span className="font-mono text-[11px] text-ink-faint">$</span>, body: <span className="truncate font-mono text-[11.5px] text-ink-soft">{entry.command}</span>, title: entry.command };
      case 'dispatch':
        return { mark: <Icon name="arrowRight" size={12} className="text-ink-faint" />, body: <span className="truncate"><span className="text-ink-faint">{t('rail.feed.dispatched')} </span><span className="font-mono text-[11.5px] text-ink">{entry.label}</span></span>, title: entry.label, onClick: () => { onOpenAgent(entry.agentId); } };
      case 'report':
        return {
          mark: <StateMark state={entry.failed ? 'failed' : 'done'} className="h-1.5 w-1.5" />,
          body: <span className="truncate"><span className="font-mono text-[11.5px] text-ink">{entry.label}</span><span className="text-ink-faint"> {t(entry.failed ? 'rail.feed.failed' : 'rail.feed.reported')} · {entry.summary ?? ''}</span></span>,
          title: `${entry.label}\n${entry.summary ?? ''}`,
          onClick: () => { onOpenAgent(entry.agentId); },
        };
      case 'compaction':
        return { mark: <span className="h-3 w-0 border-l border-dashed border-section-ink" />, body: <span className="text-section-ink">{t('rail.feed.compacted')}</span>, title: t('rail.feed.compacted') };
    }
  };
  const head = feed[0]!;
  // The folded head reads the newest entry by its short name.
  const newest = head.kind === 'file'
    ? (head.path.split(/[\\/]/).filter(Boolean).pop() ?? head.path)
    : line(head).title.split('\n', 1)[0];
  return (
    <section data-inspector-recent="">
      <FoldHead title={t('rail.feed.title')} count={feed.length} summary={newest} open={open} onToggle={() => { setOpen((v) => !v); }} />
      {open ? (
        <ol className="mt-0.5">
          {shown.map((entry) => {
            const item = line(entry);
            const content = (
              <>
                <span className="flex w-3 shrink-0 justify-center">{item.mark}</span>
                <span className="flex min-w-0 flex-1 text-[12.5px]">{item.body}</span>
                <span className="w-9 shrink-0 text-right text-[11px] text-ink-faint tabular-nums">{age(now - entry.at, locale)}</span>
              </>
            );
            return (
              <li key={entry.key}>
                {item.onClick !== undefined ? (
                  <button type="button" title={item.title} onClick={item.onClick} data-rail-open-agent={entry.kind === 'dispatch' || entry.kind === 'report' ? entry.agentId : undefined} className={`-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-ink/[0.04] ${FOCUS_RING}`}>{content}</button>
                ) : <div title={item.title} className="flex h-7 min-w-0 items-center gap-2">{content}</div>}
              </li>
            );
          })}
          {feed.length > shown.length ? (
            <li><button type="button" onClick={() => { setAll(true); }} className={`ml-3 h-7 rounded-md px-1.5 text-[12px] text-ink-faint hover:text-ink ${FOCUS_RING}`}>{t('rail.feed.earlier', { count: feed.length - shown.length })}</button></li>
          ) : null}
        </ol>
      ) : null}
    </section>
  );
});

/**
 * 能力: the focused agent's tools, skills, subagent targets and extensions,
 * as its own folded block. Reads the same agent-panel answer the profile
 * card reads (same query key), so opening it starts no extra request.
 *
 * Folded, the head carries the per-kind counts and nothing else. The names
 * behind those counts are slugs — `agent-core-dev · agent-core-review ·
 * release-kit` — which read as a wall of ids rather than a summary of what
 * the role can do, so they live in the block's own detail where each one
 * carries its scope and state, and not in a permanent line above it.
 *
 * A read that fails — or answers without the capability fields — keeps the
 * block as a plain title plus one grey status line with a text retry
 * ("can't be read right now", never an alert).
 */
export function CapabilitiesBlock({ sessionId, agentId, workspaceId, cwd }: { sessionId: string; agentId: string; workspaceId?: string; cwd?: string }) {
  const { t } = useI18n();
  const { klient } = useConnection();
  const [open, setOpen] = useState(false);
  const query = { session_id: sessionId, agent_id: agentId };
  const read = useQuery({
    queryKey: ['agentCapabilities', query],
    queryFn: ({ signal }) => klient.global.agentPanel.read(query, { signal }),
    staleTime: 5_000,
    retry: false,
  });
  const tools = useMemo(() => mapPanelTools(read.data?.tools), [read.data?.tools]);
  const skills = useMemo(() => mapPanelSkills(read.data?.skills), [read.data?.skills]);
  const targets = useMemo(() => mapPanelSubagentTargets(read.data?.targets), [read.data?.targets]);
  const data = read.data;
  const missing = data !== undefined && (data.tools === undefined || data.skills === undefined);
  // An unsupported scope stays a silent gap, the same as the profile card;
  // stale data keeps rendering through a failed background refetch.
  const failed = data === undefined && read.isError && !isCapabilityUnsupportedError(read.error);
  if (failed || missing) {
    return (
      <section data-rail-capabilities="">
        <h3 className="flex h-8 items-center gap-1.5">
          <span className={INSPECTOR_HEAD}>{t('rail.capabilities.title')}</span>
        </h3>
        <p role="status" data-rail-capabilities-unavailable className="pb-0.5 text-[12px] leading-relaxed text-ink-faint">
          {t('rail.capabilities.unavailable')}
          <button
            type="button"
            data-rail-capabilities-retry
            onClick={() => { void read.refetch(); }}
            className={`ml-1.5 rounded font-medium text-ink-soft transition-colors hover:text-ink ${FOCUS_RING}`}
          >
            {t('common.retry')}
          </button>
        </p>
      </section>
    );
  }
  if (data === undefined) return null;
  const counts = capabilityCounts(tools, skills, targets);
  const summary = t('rail.capabilities.summary', { tools: counts.toolsOn, skills: counts.skills, subagents: counts.subagents, extensions: counts.extensions });
  return (
    <section data-rail-capabilities="">
      <FoldHead title={t('rail.capabilities.title')} summary={summary} open={open} onToggle={() => { setOpen((v) => !v); }} />
      {open ? (
        <div className="pt-1">
          <AgentCapabilitiesSection tools={tools} skills={skills} subagentTargets={targets} draftScope={{ workspace_id: workspaceId, cwd }} callerProfile={data.profile?.name} inlineGroupDetail />
        </div>
      ) : null}
    </section>
  );
}
