/**
 * The default rail's own sections: the profile head over Now,
 * Needs you as plain rows, the activity feed, and capabilities as a folded
 * block of its own. Everything else on the default rail reuses the shared
 * inspector parts (agent-panel/*).
 */

import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { MAIN_AGENT_ID, type AgentForest, type Block, type NoticeBlock, type SessionViewState } from '@kiki/session-core/session';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useOptionalControllerRegistry } from '../../state/connection';
import { AgentCapabilitiesSection, capabilityCounts } from '../agent-panel/AgentCapabilitiesSection';
import { AgentDetailDrawer } from '../agent-panel/AgentDetailDrawer';
import { useAgentPanelCatalog } from '../agent-panel/useAgentPanelCatalog';
import { agentTrail } from '../agent-panel/agentRoster';
import { INSPECTOR_HEAD, InspectorChevron } from '../agent-panel/InspectorSection';
import { isCapabilityUnsupportedError, capabilityFieldGaps, mapPanelSkills, mapPanelSubagentTargets, mapPanelTools } from '../agent-panel/mapCapabilities';
import { capabilitySourceLabel, SOURCE_TONE_CLASS } from '../agent-panel/sourceLabel';
import type { AgentIdentity, DetailDrawerTarget } from '../agent-panel/types';
import { OptionalCapabilityRows, SessionMcpRail } from '../capabilities/optionalCapabilityUi';
import { SessionPluginsPanel } from '../capabilities/SessionPluginsPanel';
import { Icon } from '../icons';
import { ExecutorAuthStatus } from '../harness/ExecutorAuthStatus';
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
/**
 * Resolves the thinking effort line for the profile head.
 * For external executors, an inherited default 'off' must not be shown as the
 * engine's actual level (preserving API configuration semantics and distinguishing
 * explicit choice vs inherited default/unknown).
 */
export function profileEffortDisplay(profile: {
  executor?: string;
  thinking_effort?: string;
  thinking_effort_explicit?: boolean;
  effort_source?: string;
  thinking_effort_source?: string;
} | undefined, t: (key: I18nKey, params?: Readonly<Record<string, string | number>>) => string): string | undefined {
  if (profile?.thinking_effort === undefined) return undefined;
  const isExternal = profile.executor !== undefined && profile.executor !== '' && profile.executor !== 'native';
  if (isExternal) {
    const isOff = String(profile.thinking_effort).toLowerCase() === 'off';
    if (isOff) {
      const isExplicit = profile.thinking_effort_explicit === true;
      const isReportedByExecutor = profile.effort_source === 'executor';
      const isForcedOrAdjusted = profile.thinking_effort_source === 'forced' || profile.thinking_effort_source === 'adjusted';
      if (!isExplicit && !isReportedByExecutor && !isForcedOrAdjusted) {
        return undefined;
      }
    }
  }
  return t('subagent.effort', { effort: String(profile.thinking_effort) });
}

export function ProfileHead({ sessionId, agentId, label, fallbackModel, workspaceId, cwd, externalDriver }: {
  sessionId: string;
  agentId: string;
  label: string;
  fallbackModel?: string;
  workspaceId?: string;
  cwd?: string;
  /**
   * The client driving this session, when one is. A driven main has no Kiki
   * model, so the model line names the driver instead of printing a model
   * alias that cannot answer anything.
   */
  externalDriver?: string;
}) {
  const { t } = useI18n();
  const [drawer, setDrawer] = useState<DetailDrawerTarget | null>(null);
  const query = { session_id: sessionId, agent_id: agentId };
  const state = useAgentState(sessionId, agentId);
  const read = useAgentPanelCatalog(query, drawer !== null,
    JSON.stringify([state?.profile, state?.model, state?.permissionMode, state?.planMode]));
  const tools = useMemo(() => mapPanelTools(read.data?.tools), [read.data?.tools]);
  const skills = useMemo(() => mapPanelSkills(read.data?.skills), [read.data?.skills]);
  const targets = useMemo(() => mapPanelSubagentTargets(read.data?.targets), [read.data?.targets]);
  const profile = read.data?.profile;
  const profileName = profile?.name !== undefined && profile.name !== '' && profile.name !== 'unknown' ? profile.name : undefined;
  const model = profile?.model ?? state?.model ?? (agentId === MAIN_AGENT_ID ? fallbackModel : undefined);
  const effortText = profileEffortDisplay(profile, t);
  const externalDefault = effortText === undefined && profile?.executor !== undefined
    && profile.executor !== '' && profile.executor !== 'native';
  const effortLabel = externalDefault
    ? t('subagent.effort', { effort: t('st.engines.defaults.inheritPlaceholder') })
    : effortText;
  // A driven main has no model of its own. A sub agent under it still does, and
  // keeps its real model and effort, because that model did run.
  const modelLine = externalDriver !== undefined
    ? t('rail.external.driver', { client: externalDriver })
    : [model, effortLabel]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · ');
  const source = capabilitySourceLabel(t, { source: profile?.source, sourceFile: profile?.source_file });
  const identity: AgentIdentity = {
    id: agentId, sessionId, profile: profileName ?? '', label, model,
    thinkingEffort: effortText !== undefined ? profile?.thinking_effort : undefined,
    thinkingEffortExplicit: profile?.thinking_effort_explicit,
    executorId: profile?.executor,
    status: 'unknown',
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
        <p data-rail-profile-model data-rail-driver={externalDriver === undefined ? undefined : 'external'}
          className="truncate text-[12.5px] leading-5 text-ink-faint" title={modelLine}>{modelLine}</p>
      ) : null}
      {/* The usage below is Kiki's own: what its sub agents really cost. It is
          labelled here so a driven session's figures are never read as the
          external client's, which Kiki cannot see and does not report. */}
      {externalDriver !== undefined && agentId === MAIN_AGENT_ID ? (
        <p data-rail-usage-scope className="mt-0.5 text-[11.5px] leading-4 text-ink-faint">
          {t('rail.external.usageScope')}
        </p>
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
      {!open && summary !== undefined ? <span data-fold-summary className="min-w-0 flex-1 truncate text-right text-[12px] text-ink-faint">{summary}</span> : <span className="flex-1" />}
      <InspectorChevron open={open} />
    </button>
  );
}

type FeedEntry =
  | { kind: 'file'; key: string; at: number; path: string; op: 'read' | 'edit' | 'write'; error: boolean }
  | { kind: 'command'; key: string; at: number; command: string; error: boolean }
  | { kind: 'dispatch'; key: string; at: number; agentId: string; label: string }
  | { kind: 'report'; key: string; at: number; agentId: string; label: string; failed: boolean; summary: string | undefined }
  | { kind: 'compaction'; key: string; at: number; i18n: NonNullable<NoticeBlock['i18n']> };

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
    } else if (block.kind === 'notice' && block.i18n !== undefined && block.i18n.key.startsWith('transcript.marker.compaction') && block.createdAt !== undefined) {
      out.push({ kind: 'compaction', key: block.id, at: Date.parse(block.createdAt), i18n: block.i18n });
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
      case 'compaction': {
        const label = t(entry.i18n.key, entry.i18n.params);
        return { mark: <span className="h-3 w-0 border-l border-dashed border-section-ink" />, body: <span className="text-section-ink">{label}</span>, title: label };
      }
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
 * What the focused agent can use, as one fold: the observation tabs (tools,
 * skills, dispatch targets) sit directly beside the session's own switches
 * (plugins, system capabilities, MCP servers), because the reader's question
 * — "它能用什么" — covers both. Plugin and MCP tools remain in the tools
 * inventory because they are still part of the observed, complete tool list.
 */
export function CapabilitiesBlock({ sessionId, agentId, workspaceId, cwd }: { sessionId: string; agentId: string; workspaceId?: string; cwd?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const query = { session_id: sessionId, agent_id: agentId };
  const state = useAgentState(sessionId, agentId);
  const read = useAgentPanelCatalog(query, open,
    JSON.stringify([state?.profile, state?.model, state?.permissionMode, state?.planMode]));
  const tools = useMemo(() => mapPanelTools(read.data?.tools), [read.data?.tools]);
  const skills = useMemo(() => mapPanelSkills(read.data?.skills), [read.data?.skills]);
  const targets = useMemo(() => mapPanelSubagentTargets(read.data?.targets), [read.data?.targets]);
  const data = read.data;
  const capUnsupported = isCapabilityUnsupportedError(read.error);
  const capFailed = data === undefined && read.isError && !capUnsupported;
  const capPending = data === undefined && !read.isError;
  const gaps = data === undefined || capUnsupported ? undefined : capabilityFieldGaps(data);

  const segments: string[] = [];
  if (data !== undefined && !capUnsupported) {
    const counts = capabilityCounts(tools, skills, targets);
    if (data.tools !== undefined) segments.push(`${t('inspector.cap.tools')} ${counts.toolsOn}`);
    if (data.skills !== undefined) segments.push(`${t('inspector.cap.skills')} ${counts.skills}`);
    if (data.targets !== undefined) segments.push(`${t('inspector.cap.subagents')} ${counts.subagents}`);
  }
  const summary = segments.length === 0 ? undefined : segments.join(' · ');

  return (
    <section data-rail-capabilities="">
      <FoldHead
        title={t('rail.capabilities.title')}
        summary={summary}
        open={open}
        onToggle={() => { setOpen((value) => !value); }}
      />
      {open ? (
        <div className="pt-1 space-y-4">
          {!capUnsupported ? (
            <div>
              <ExecutorAuthStatus observation={data?.executor_auth} />
              <AgentCapabilitiesSection
                tools={tools}
                skills={skills}
                subagentTargets={targets}
                draftScope={{ workspace_id: workspaceId, cwd }}
                callerProfile={data?.profile?.name}
                capabilitiesStatus={capFailed ? 'failed' : capPending ? 'loading' : 'ready'}
                onRetryCapabilities={() => { void read.refetch(); }}
                capabilityGaps={gaps}
              />
            </div>
          ) : null}
          <div className="-mx-2" data-rail-control-group="plugins">
            <h4 className="flex items-baseline gap-1.5 px-2 pb-0.5 text-[11px] font-medium text-ink-faint">
              {t('inspector.cap.plugins')}
            </h4>
            <SessionPluginsPanel sessionId={sessionId} />
          </div>
          <div data-rail-control-group="system">
            <h4 className="pb-0.5 text-[11px] font-medium text-ink-faint">{t('rail.capabilities.systemTitle')}</h4>
            <OptionalCapabilityRows sessionId={sessionId} />
          </div>
          <SessionMcpRail sessionId={sessionId} />
        </div>
      ) : null}
    </section>
  );
}
