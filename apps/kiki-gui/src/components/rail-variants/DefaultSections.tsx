/**
 * The default rail's own sections (prototype): Needs you as a decision
 * stack, the todo pointer under Now, the activity feed, and capabilities as
 * a folded block of its own. Everything else on the default rail reuses the
 * current inspector's parts unchanged.
 */

import { memo, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { MAIN_AGENT_ID, type AgentForest, type Block, type TodoItem } from '@kiki/session-core/session';
import { useConnection } from '../../state/connection';
import { AgentCapabilitiesSection, capabilityCounts } from '../agent-panel/AgentCapabilitiesSection';
import { agentTrail } from '../agent-panel/agentRoster';
import { INSPECTOR_HEAD, InspectorChevron } from '../agent-panel/InspectorSection';
import { mapPanelSkills, mapPanelSubagentTargets, mapPanelTools } from '../agent-panel/mapCapabilities';
import { Icon } from '../icons';
import { age, decidable, familyOf, FAMILY_TONE, pendingId, pendingSubject, useNow, type PendingItem } from './model';
import { FOCUS_RING, StateMark, useDecide } from './shell';

const SECTION_BUTTON = `group -ml-1.5 flex h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] ${FOCUS_RING}`;
const FAMILY_NAME = { opus: 'Opus', sol: 'Sol', luna: 'Luna', ds: 'DeepSeek', other: '' } as const;

const SHOWN_ROWS = 3;

/**
 * Needs you, oldest request first. The first item is a full card (who asked,
 * what they were doing, the exact command, big buttons); the rest are one
 * line each with inline decisions, and beyond three more they fold.
 */
export const NeedsYouStack = memo(function NeedsYouStack({
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
  const now = useNow();
  const { sending, decide, canDecide } = useDecide(onResolveApproval);
  const [showAll, setShowAll] = useState(false);
  const ordered = useMemo(
    () => items.toSorted((l, r) => Date.parse(l.kind === 'approval' ? l.request.created_at : l.request.created_at) - Date.parse(r.kind === 'approval' ? r.request.created_at : r.request.created_at)),
    [items],
  );
  if (ordered.length === 0) return null;
  const [first, ...rest] = ordered as [PendingItem, ...PendingItem[]];
  const shown = showAll ? rest : rest.slice(0, SHOWN_ROWS);
  const hidden = rest.length - shown.length;

  const who = (item: PendingItem) => {
    const origin = item.originUnknown === true ? undefined : item.originAgentId;
    const node = origin !== undefined && origin !== MAIN_AGENT_ID ? forest.byId[origin] : undefined;
    return { id: node?.agentId, label: node?.label ?? '主智能体', trail: node !== undefined ? agentTrail(forest, node.agentId) : [], node };
  };
  const created = (item: PendingItem) => Date.parse(item.request.created_at);
  const actions = (item: PendingItem, size: 'lg' | 'sm') => {
    const id = pendingId(item);
    const busy = sending.has(id);
    const h = size === 'lg' ? 'h-8 flex-1 text-[13px]' : 'h-7 px-2 text-[12px]';
    if (decidable(item) && canDecide) {
      return (
        <>
          <button type="button" data-needs-you-approve={id} disabled={busy} onClick={() => { decide(item, 'approved'); }} className={`${h} shrink-0 rounded-md bg-attention font-semibold text-on-accent transition-colors hover:bg-accent-deep disabled:opacity-50 ${FOCUS_RING}`}>批准</button>
          <button type="button" data-needs-you-reject={id} disabled={busy} onClick={() => { decide(item, 'rejected'); }} className={`${h} shrink-0 rounded-md ${size === 'lg' ? 'ring-1 ring-hairline-strong ring-inset' : ''} text-ink-soft transition-colors hover:bg-danger/[0.08] hover:text-danger disabled:opacity-50 ${FOCUS_RING}`}>拒绝</button>
        </>
      );
    }
    return (
      <button type="button" data-inspector-review={id} onClick={() => { onReview?.(item.kind, id); }} className={`${h} shrink-0 rounded-md bg-attention font-semibold text-on-accent transition-colors hover:bg-accent-deep ${FOCUS_RING}`}>
        {item.kind === 'question' ? '去回答' : '查看'}
      </button>
    );
  };
  const lead = who(first);
  const leadTone = lead.node !== undefined ? FAMILY_TONE[familyOf(lead.node.model)] : undefined;
  return (
    <section data-inspector-needs-you="" aria-label="等你处理" className="space-y-1.5">
      <h3 className="flex h-6 items-center gap-1.5">
        <span className="text-[12px] font-semibold text-attention">等你处理</span>
        <span className="rounded-full bg-attention px-1.5 text-[11px] leading-[18px] font-semibold text-on-accent tabular-nums">{ordered.length}</span>
        <span className="ml-auto text-[11.5px] text-ink-faint">最早的在前</span>
      </h3>

      <article data-needs-you-item={pendingId(first)} className="rounded-xl bg-attention-soft/70 p-2.5 ring-1 ring-attention/25 ring-inset">
        <div className="flex min-w-0 items-center gap-1.5">
          {lead.id !== undefined ? (
            <button type="button" data-needs-you-from={lead.id} onClick={() => { onInspect(lead.id!); }} title={[...lead.trail, lead.label].join(' › ')} className={`min-w-0 truncate rounded font-mono text-[12.5px] font-semibold text-ink hover:underline ${FOCUS_RING}`}>{lead.label}</button>
          ) : <span className="text-[12.5px] font-semibold text-ink">{lead.label}</span>}
          {lead.node !== undefined && leadTone !== undefined ? <span className={`shrink-0 rounded px-1 text-[10.5px] leading-4 font-semibold ${leadTone.soft} ${leadTone.text}`}>{FAMILY_NAME[familyOf(lead.node.model)]}</span> : null}
          <span className="ml-auto shrink-0 text-[11.5px] text-attention tabular-nums">{age(now - created(first), 'zh')}前</span>
        </div>
        {lead.node?.description !== undefined ? <p className="mt-0.5 line-clamp-1 text-[12px] leading-[18px] text-ink-soft" title={lead.node.description}>{lead.node.description}</p> : null}
        <p className="mt-1.5 line-clamp-3 rounded-md bg-shell px-2 py-1.5 font-mono text-[11.5px] leading-[17px] break-all text-shell-ink-strong" title={pendingSubject(first)}>
          <span className="mr-1.5 text-shell-ink-soft">{first.kind === 'approval' ? first.request.tool_name : '问'}</span>
          {pendingSubject(first)}
        </p>
        <div className="mt-2 flex gap-1.5">{actions(first, 'lg')}</div>
      </article>

      {shown.length > 0 ? (
        <ul className="divide-y divide-attention/10 rounded-xl ring-1 ring-attention/20 ring-inset">
          {shown.map((item) => {
            const from = who(item);
            return (
              <li key={pendingId(item)} data-needs-you-item={pendingId(item)} className="flex min-w-0 items-center gap-2 py-1.5 pr-1.5 pl-2.5">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-attention" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    {from.id !== undefined ? (
                      <button type="button" data-needs-you-from={from.id} onClick={() => { onInspect(from.id!); }} title={[...from.trail, from.label].join(' › ')} className={`min-w-0 truncate rounded font-mono text-[12px] font-medium text-ink hover:underline ${FOCUS_RING}`}>{from.label}</button>
                    ) : <span className="text-[12px] font-medium text-ink">{from.label}</span>}
                    <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">{age(now - created(item), 'zh')}</span>
                  </span>
                  <span className="block truncate font-mono text-[11.5px] text-ink-soft" title={pendingSubject(item)}>
                    <span className="text-ink-faint">{item.kind === 'approval' ? item.request.tool_name : '问'} </span>{pendingSubject(item)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-0.5">{actions(item, 'sm')}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <button type="button" onClick={() => { setShowAll(true); }} className={`h-7 rounded-md px-1.5 text-[12.5px] font-medium text-attention hover:bg-attention-soft ${FOCUS_RING}`}>还有 {hidden} 件</button>
      ) : null}
    </section>
  );
});

/**
 * One line under Now: which checklist item is in progress and how far along
 * the list is, with a thin progress bar. The full list lives in 待办 below.
 */
export function TodoPointer({ todos }: { todos: readonly TodoItem[] }) {
  if (todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === 'done').length;
  const current = todos.find((todo) => todo.status === 'in_progress') ?? todos.find((todo) => todo.status === 'pending');
  return (
    <a href="#rail-todos" data-rail-todo-pointer className={`-mx-1.5 mt-2 block rounded-md px-1.5 py-1 hover:bg-ink/[0.04] ${FOCUS_RING}`}>
      <span className="flex min-w-0 items-baseline gap-2 text-[12px]">
        <span className="shrink-0 text-ink-faint">待办</span>
        <span className="min-w-0 flex-1 truncate text-ink" title={current?.title}>{current?.title ?? '全部完成'}</span>
        <span className="shrink-0 text-ink-faint tabular-nums">{done}/{todos.length}</span>
      </span>
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-ink/[0.07]">
        <span className="block h-full rounded-full bg-selected-ink/70" style={{ width: `${Math.round((done / todos.length) * 100)}%` }} />
      </span>
    </a>
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
        return { mark: <Icon name="arrowRight" size={12} className="text-ink-faint" />, body: <span className="truncate"><span className="text-ink-faint">派出 </span><span className="font-mono text-[11.5px] text-ink">{entry.label}</span></span>, title: entry.label, onClick: () => { onOpenAgent(entry.agentId); } };
      case 'report':
        return {
          mark: <StateMark state={entry.failed ? 'failed' : 'done'} className="h-1.5 w-1.5" />,
          body: <span className="truncate"><span className="font-mono text-[11.5px] text-ink">{entry.label}</span><span className="text-ink-faint"> {entry.failed ? '失败' : '回报'} · {entry.summary ?? ''}</span></span>,
          title: `${entry.label}\n${entry.summary ?? ''}`,
          onClick: () => { onOpenAgent(entry.agentId); },
        };
      case 'compaction':
        return { mark: <span className="h-3 w-0 border-l border-dashed border-section-ink" />, body: <span className="text-section-ink">上下文已压缩</span>, title: '上下文已压缩' };
    }
  };
  const head = feed[0]!;
  // The folded head reads the newest entry by its short name.
  const newest = head.kind === 'file'
    ? (head.path.split(/[\\/]/).filter(Boolean).pop() ?? head.path)
    : line(head).title.split('\n', 1)[0];
  return (
    <section data-inspector-recent="">
      <FoldHead title="动态" count={feed.length} summary={newest} open={open} onToggle={() => { setOpen((v) => !v); }} />
      {open ? (
        <ol className="mt-0.5">
          {shown.map((entry) => {
            const item = line(entry);
            const content = (
              <>
                <span className="flex w-3 shrink-0 justify-center">{item.mark}</span>
                <span className="flex min-w-0 flex-1 text-[12.5px]">{item.body}</span>
                <span className="w-9 shrink-0 text-right text-[11px] text-ink-faint tabular-nums">{age(now - entry.at, 'zh')}</span>
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
            <li><button type="button" onClick={() => { setAll(true); }} className={`ml-3.5 h-7 rounded-md px-1.5 text-[12px] text-ink-faint hover:text-ink ${FOCUS_RING}`}>更早的 {feed.length - shown.length} 条</button></li>
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
 */
export function CapabilitiesBlock({ sessionId, agentId, workspaceId, cwd }: { sessionId: string; agentId: string; workspaceId?: string; cwd?: string }) {
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
  if (read.data?.tools === undefined || read.data.skills === undefined) return null;
  const counts = capabilityCounts(tools, skills, targets);
  const summary = `工具 ${counts.toolsOn} · 技能 ${counts.skills} · 子智能体 ${counts.subagents} · 扩展 ${counts.extensions}`;
  return (
    <section data-rail-capabilities="">
      <FoldHead title="能力" summary={summary} open={open} onToggle={() => { setOpen((v) => !v); }} />
      {open ? (
        <div className="pt-1">
          <AgentCapabilitiesSection tools={tools} skills={skills} subagentTargets={targets} draftScope={{ workspace_id: workspaceId, cwd }} callerProfile={read.data.profile?.name} />
        </div>
      ) : null}
    </section>
  );
}
