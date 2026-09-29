/**
 * The inspector's top chapters — what the focused agent is doing right now,
 * what is waiting on the user, and what it touched recently. All three read
 * the focused agent's own blocks; each renders nothing when it has nothing
 * to say (no "Unknown" rows, no error walls).
 */

import { memo, useMemo, type ReactNode } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import type { ApprovalBlock, Block, QuestionBlock, ToolBlock } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import type { LifeState } from '../../lib/motion';
import { ClampText } from '../ClampText';
import { Icon } from '../icons';
import { LifeMark } from '../LifeMark';
import { useNow } from '../RelativeTime';
import { toolSummary } from '../ToolCard';
import { RAIL_MARK } from './InspectorAgents';
import { INSPECTOR_LINK, InspectorSection } from './InspectorSection';

type Pending = ApprovalBlock | QuestionBlock;

export function pendingBlocks(blocks: readonly Block[]): Pending[] {
  return blocks.filter(
    (block): block is Pending =>
      (block.kind === 'approval' && block.resolution === undefined) ||
      (block.kind === 'question' && block.outcome === undefined),
  );
}

export function runningTool(blocks: readonly Block[]): ToolBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === 'tool' && block.status === 'running') return block;
  }
  return undefined;
}

/** The last thing the agent said, as one plain paragraph (markdown marks dropped). */
export function latestSaid(blocks: readonly Block[]): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind !== 'assistant' || block.text.trim() === '') continue;
    const paragraphs = block.text.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part !== '' && !part.startsWith('```'));
    const last = paragraphs[paragraphs.length - 1];
    if (last === undefined) continue;
    const plain = last.replace(/^[#>*\-\s]+/gm, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
    if (plain !== '') return plain.length > 280 ? `${plain.slice(0, 280)}…` : plain;
  }
  return undefined;
}

/** Live "3m 12s" since `since`; subscribes to the shared second clock. */
function Elapsed({ since }: { since: number }) {
  const { time } = useI18n();
  const now = useNow();
  // Under a second is noise, not a duration worth reading.
  if (!Number.isFinite(since) || now - since < 1000) return null;
  return <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{time.formatDuration(now - since)}</span>;
}

/**
 * The running step as a short phrase: the tool's own name as the verb (the
 * timeline says it the same way) and a compact object, the file name for a
 * path, the first line for a command.
 */
function stepPhrase(tool: ToolBlock, summary: string): { verb: string; object: string | undefined } {
  const display = tool.display;
  const path = display?.kind === 'file_io' || display?.kind === 'diff' ? display.path : undefined;
  const object = path !== undefined
    ? (path.split(/[\\/]/).filter((part) => part !== '').pop() ?? path)
    : (summary.split('\n', 1)[0] ?? '').trim();
  return { verb: tool.name, object: object === '' ? undefined : object };
}

/** What the focused subagent was asked, what it found, or how it failed. */
export interface NowSubagent {
  readonly status: string;
  readonly brief: string | undefined;
  readonly result: string | undefined;
  readonly error: string | undefined;
  /** Pending approvals / questions from this subagent. */
  readonly pendingCount: number;
}

/**
 * The inspector's lead: what this agent is doing right now. The headline is
 * the running step (verb and object), falling back to the state word; the
 * elapsed run time sits at its right; under it at most two lines of what the
 * agent last said or found. Anything waiting on the user comes first and
 * carries the rail's one accent.
 */
export const InspectorNow = memo(function InspectorNow({
  blocks,
  busy,
  pending,
  onReview,
  startedAt,
  subagent,
  actions,
  listPending = true,
}: {
  /** False when a session-wide Needs you block above already lists them. */
  listPending?: boolean;
  blocks: readonly Block[];
  busy: boolean;
  pending: readonly Pending[];
  onReview?: (kind: 'approval' | 'question', id: string) => void;
  /** Epoch ms the current run began (turn start or subagent start). */
  startedAt: number | undefined;
  subagent?: NowSubagent;
  /** Open / locate controls for the focused agent. */
  actions?: ReactNode;
}) {
  const { t, tp } = useI18n();
  const pendingCount = Math.max(pending.length, subagent?.pendingCount ?? 0);
  const subStatus = subagent?.status;
  const running = busy || subStatus === 'running' || subStatus === 'background';
  const tool = running ? runningTool(blocks) : undefined;
  const said = useMemo(() => latestSaid(blocks), [blocks]);
  const life: LifeState = pendingCount > 0
    ? 'waiting'
    : running
      ? 'working'
      : subStatus === 'failed' ? 'failed' : subStatus === 'completed' ? 'done' : 'idle';
  const state = pendingCount > 0 ? 'waiting' : running ? 'working' : 'idle';
  const summary = tool === undefined ? '' : toolSummary(tool, t, tp);
  const phrase = tool === undefined ? undefined : stepPhrase(tool, summary);
  // A bare verb ("Agent") says less than the state word; it needs its object.
  const step = phrase?.object === undefined ? undefined : phrase;
  const word = pendingCount > 0
    ? t('inspector.nowWaiting')
    : subStatus !== undefined && !running
      ? t(`subagent.status.${subStatus}` as I18nKey)
      : running ? t('inspector.nowWorking') : t('inspector.nowIdle');
  const failed = subStatus === 'failed' && subagent?.error !== undefined;
  const result = subStatus === 'completed' ? subagent?.result : undefined;
  // The excerpt: a failure, a result, the brief of a subagent that has not
  // spoken yet, or the last thing a running agent said. One of them, never
  // a stack of three.
  const excerpt = failed
    ? undefined
    : result !== undefined && result !== ''
      ? result
      : running && said !== undefined
        ? said
        : subagent?.brief;
  const quiet = state === 'idle' && subStatus === undefined;
  return (
    <section data-inspector-now={state} className="space-y-3">
      {listPending && pending.length > 0 ? (
        <ul data-inspector-needs-you="" aria-label={t('inspector.needsYou')} className="-mx-2 space-y-1">
          {pending.map((item) => {
            const id = item.kind === 'approval' ? item.request.approval_id : item.request.question_id;
            return (
              <li key={id} className="flex min-h-9 items-center rounded-lg bg-accent-soft/50 py-1 pr-1 pl-2">
                <span className={RAIL_MARK}>
                  <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-accent" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{pendingLabel(t, item)}</span>
                {onReview !== undefined ? (
                  <button
                    type="button"
                    data-inspector-review={id}
                    onClick={() => { onReview(item.kind, id); }}
                    className="h-7 shrink-0 rounded-md px-2 text-[12.5px] font-medium text-accent-ink transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    {t('inspector.review')}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div>
        <div className="flex min-w-0 items-start">
          <span className={RAIL_MARK}>
            <LifeMark markId="inspector-now" life={life} />
          </span>
          <p
            data-agent-status={subStatus}
            data-needs-input={subagent !== undefined && subagent.pendingCount > 0 ? '' : undefined}
            data-inspector-step={step !== undefined ? '' : undefined}
            title={summary === '' ? undefined : summary}
            className={`min-w-0 flex-1 truncate text-[14px] leading-5 font-medium ${quiet ? 'text-ink-soft' : failed ? 'text-danger' : 'text-ink'}`}
          >
            {step !== undefined ? (
              <>
                {step.verb}
                {step.object !== undefined ? <span className="ml-1.5 font-mono text-[12.5px] font-normal text-ink-soft">{step.object}</span> : null}
              </>
            ) : word}
          </p>
          {/* A subagent's own requests surface in main's transcript, so its
              rail may hold a count without the rows; say how many. */}
          {pendingCount > 1 || (pendingCount > 0 && pending.length === 0) ? (
            <span className="ml-2 shrink-0 text-[12px] leading-5 text-ink-faint tabular-nums">{pendingCount}</span>
          ) : null}
          {running && startedAt !== undefined ? <span className="ml-3 leading-5"><Elapsed since={startedAt} /></span> : null}
        </div>
        {failed ? (
          <div className="mt-1.5 ml-3.5 border-l-2 border-danger pl-2.5">
            <ClampText text={subagent.error ?? ''} lines={3} className="font-mono text-[12px] leading-snug text-danger" />
          </div>
        ) : excerpt !== undefined && excerpt !== '' ? (
          <p
            data-inspector-said
            className="mt-1 ml-3.5 line-clamp-2 text-[13px] leading-[19px] text-ink-soft"
            // A result or a live excerpt stands in for the brief; the brief
            // stays one hover away.
            title={subagent?.brief !== undefined && subagent.brief !== excerpt ? `${excerpt}\n\n${subagent.brief}` : excerpt}
          >
            {excerpt}
          </p>
        ) : null}
      </div>
      {actions}
    </section>
  );
});

/** Quiet inline action row under Now (Open, Show in timeline). */
export function NowAction({ icon, label, onClick, ...data }: {
  icon: 'external' | 'arrowUp' | 'arrowRight';
  label: string;
  onClick: () => void;
} & { [key: `data-${string}`]: string | undefined }) {
  return (
    <button type="button" onClick={onClick} className={INSPECTOR_LINK} {...data}>
      <Icon name={icon} size={12} className="text-ink-faint" />
      {label}
    </button>
  );
}

function pendingLabel(t: ReturnType<typeof useI18n>['t'], item: Pending): string {
  if (item.kind === 'approval') return t('inspector.approvalItem', { tool: item.request.tool_name });
  const first = item.request.questions[0];
  return first?.header ?? first?.question ?? t('inspector.questionItem');
}

interface FileTouch {
  readonly path: string;
  readonly op: 'read' | 'edit' | 'write';
  readonly error: boolean;
}

const MAX_FILES = 6;
const MAX_COMMANDS = 3;

function recentActivity(blocks: readonly Block[]): { files: FileTouch[]; commands: string[] } {
  const files = new Map<string, FileTouch>();
  const commands: string[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind !== 'tool') continue;
    const display = block.display;
    if (display === undefined) continue;
    if ((display.kind === 'file_io' && display.operation !== 'glob' && display.operation !== 'grep') || display.kind === 'diff') {
      if (files.size >= MAX_FILES || files.has(display.path)) continue;
      const op = display.kind === 'diff' || display.operation === 'edit' ? 'edit' : display.operation === 'write' ? 'write' : 'read';
      files.set(display.path, { path: display.path, op, error: block.isError === true || block.status === 'error' });
    } else if (display.kind === 'command' && commands.length < MAX_COMMANDS) {
      commands.push(display.command);
    }
  }
  return { files: [...files.values()], commands };
}

function fileName(path: string): { name: string; dir: string } {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  const name = parts.pop() ?? path;
  const dir = parts.slice(-2).join('/');
  return { name, dir };
}

/** Recently touched files (newest first; edits marked) and recent commands. */
export const InspectorRecent = memo(function InspectorRecent({
  blocks,
  onOpenFile,
}: {
  blocks: readonly Block[];
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const { files, commands } = useMemo(() => recentActivity(blocks), [blocks]);
  if (files.length === 0 && commands.length === 0) return null;
  return (
    <InspectorSection title={t('inspector.recent')} data-inspector-recent="">
      <div className="space-y-2.5">
        {files.length > 0 ? (
          <ul aria-label={t('inspector.recentFiles')} className="space-y-px">
            {files.map((file) => {
              const { name, dir } = fileName(file.path);
              const body = (
                <>
                  <span
                    aria-hidden
                    className={`w-3 shrink-0 text-center font-mono text-[10.5px] ${
                      file.error ? 'text-danger' : file.op === 'read' ? 'text-ink-faint' : 'text-amber-ink'
                    }`}
                  >
                    {file.op === 'read' ? '·' : file.op === 'write' ? '+' : '~'}
                  </span>
                  <span className="min-w-0 truncate text-[12.5px] text-ink">{name}</span>
                  {dir !== '' ? <span className="min-w-0 shrink-[4] truncate text-[11.5px] text-ink-faint">{dir}</span> : null}
                </>
              );
              return (
                <li key={file.path}>
                  {onOpenFile !== undefined ? (
                    <button
                      type="button"
                      data-inspector-file={file.path}
                      title={file.path}
                      onClick={() => { onOpenFile(file.path); }}
                      className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                    >
                      {body}
                    </button>
                  ) : (
                    <span title={file.path} className="flex h-7 min-w-0 items-center gap-1.5">{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {commands.length > 0 ? (
          <ul aria-label={t('inspector.recentCommands')} className="space-y-0.5">
            {commands.map((command, index) => (
              <li
                key={`${index}:${command}`}
                title={command}
                className="truncate rounded-md bg-ink/[0.035] px-2 py-1 font-mono text-[11.5px] text-ink-soft"
              >
                <span aria-hidden className="mr-1.5 text-ink-faint">$</span>
                {command}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </InspectorSection>
  );
});
