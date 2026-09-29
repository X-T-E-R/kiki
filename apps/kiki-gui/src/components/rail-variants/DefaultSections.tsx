/**
 * The default rail's own sections (prototype): Needs you as plain rows, the
 * todo pointer under Now, the activity feed, and capabilities as a folded
 * block of its own. Everything else on the default rail reuses the current
 * inspector's parts unchanged. Every section takes the variant's tone.
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
import { age, decidable, pendingId, pendingSubject, useNow, type PendingItem } from './model';
import { FOCUS_RING, StateMark, useDecide } from './shell';
import type { RailTone } from './tone';

const SECTION_BUTTON = `group -ml-1.5 flex h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] ${FOCUS_RING}`;

const SHOWN_ROWS = 4;

/**
 * Needs you as plain rows, oldest first: a dot, who asked and when, the
 * object in one mono line, text controls at the end. The full card lives in
 * the composer tray; 查看 focuses it. Beyond four rows the rest fold.
 */
export const NeedsYouList = memo(function NeedsYouList({
  items,
  forest,
  tone,
  onResolveApproval,
  onReview,
  onInspect,
}: {
  items: readonly PendingItem[];
  forest: AgentForest;
  tone: RailTone;
  onResolveApproval?: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onReview?: (kind: 'approval' | 'question', id: string) => void;
  onInspect: (agentId: string) => void;
}) {
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
    <section data-inspector-needs-you="" aria-label="等你处理">
      <h3 className="flex h-7 items-center gap-1.5">
        <span className={tone.head.replace(/text-(ink-soft|section-ink)/, 'text-attention')}>等你处理</span>
        <span className={tone.needsCount}>{ordered.length}</span>
      </h3>
      <ul className={tone.needsList}>
        {shown.map((item) => {
          const id = pendingId(item);
          const origin = item.originUnknown === true ? undefined : item.originAgentId;
          const node = origin !== undefined && origin !== MAIN_AGENT_ID ? forest.byId[origin] : undefined;
          const trail = node !== undefined ? [...agentTrail(forest, node.agentId), node.label].join(' › ') : '主智能体';
          const busy = sending.has(id);
          return (
            <li key={id} data-needs-you-item={id} className={`flex min-w-0 items-center gap-2 py-1 ${tone.needsRow}`}>
              <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-attention" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5 leading-5">
                  {node !== undefined ? (
                    <button type="button" data-needs-you-from={node.agentId} title={trail} onClick={() => { onInspect(node.agentId); }} className={`min-w-0 truncate rounded text-[13px] text-ink hover:underline ${FOCUS_RING}`}>{node.label}</button>
                  ) : <span className="text-[13px] text-ink">主智能体</span>}
                  <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">{age(now - Date.parse(item.request.created_at), 'zh')}</span>
                </span>
                <span className="block truncate font-mono text-[11.5px] leading-[18px] text-ink-faint" title={pendingSubject(item)}>
                  {item.kind === 'approval' ? `${item.request.tool_name} ` : '问 '}{pendingSubject(item)}
                </span>
              </span>
              {decidable(item) && canDecide ? (
                <span className="flex shrink-0 items-center gap-0.5">
                  <button type="button" data-needs-you-approve={id} disabled={busy} onClick={() => { decide(item, 'approved'); }} className={`${tone.approve} disabled:opacity-50 ${FOCUS_RING}`}>批准</button>
                  <button type="button" data-needs-you-reject={id} disabled={busy} onClick={() => { decide(item, 'rejected'); }} className={`${tone.reject} disabled:opacity-50 ${FOCUS_RING}`}>拒绝</button>
                </span>
              ) : (
                <button type="button" data-inspector-review={id} onClick={() => { onReview?.(item.kind, id); }} className={`${tone.approve} ${FOCUS_RING}`}>{item.kind === 'question' ? '去回答' : '查看'}</button>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <button type="button" onClick={() => { setShowAll(true); }} className={`mt-0.5 h-7 rounded-md px-1.5 text-[12.5px] text-ink-faint hover:text-ink ${FOCUS_RING}`}>还有 {hidden} 件</button>
      ) : null}
    </section>
  );
});

/**
 * One line under Now: which checklist item is in progress and how far along
 * the list is, with a thin progress bar. The full list lives in 待办 below.
 */
export function TodoPointer({ todos, tone }: { todos: readonly TodoItem[]; tone: RailTone }) {
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
      <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-ink/[0.07]">
        <span className={`block h-full rounded-full ${tone.pointerFill}`} style={{ width: `${Math.round((done / todos.length) * 100)}%` }} />
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
