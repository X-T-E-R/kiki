/**
 * The inspector's top chapters — what the focused agent is doing right now,
 * what is waiting on the user, and what it touched recently. All three read
 * the focused agent's own blocks; each renders nothing when it has nothing
 * to say (no "Unknown" rows, no error walls).
 */

import { memo, useMemo } from 'react';

import type { ApprovalBlock, Block, QuestionBlock, ToolBlock } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { LifeMark } from '../LifeMark';
import { InspectorSection } from './InspectorSection';

type Pending = ApprovalBlock | QuestionBlock;

export function pendingBlocks(blocks: readonly Block[]): Pending[] {
  return blocks.filter(
    (block): block is Pending =>
      (block.kind === 'approval' && block.resolution === undefined) ||
      (block.kind === 'question' && block.outcome === undefined),
  );
}

function runningTool(blocks: readonly Block[]): ToolBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === 'tool' && block.status === 'running') return block;
  }
  return undefined;
}

/**
 * One-line "now" status: a state dot, a verb phrase, and the latest running
 * tool when there is one. Sits directly under the inspector heading.
 */
export const InspectorNowLine = memo(function InspectorNowLine({
  blocks,
  busy,
  pendingCount,
}: {
  blocks: readonly Block[];
  busy: boolean;
  pendingCount: number;
}) {
  const { t } = useI18n();
  const tool = busy ? runningTool(blocks) : undefined;
  const state = pendingCount > 0 ? 'waiting' : busy ? 'working' : 'idle';
  const text = state === 'waiting'
    ? t('inspector.nowWaiting')
    : tool !== undefined
      ? t('inspector.nowRunningTool', { tool: tool.name })
      : state === 'working' ? t('inspector.nowWorking') : t('inspector.nowIdle');
  const detail = tool?.description ?? (tool?.display?.kind === 'command' ? tool.display.command : undefined);
  return (
    <div data-inspector-now={state} className="flex min-w-0 items-start gap-2 text-[13px]">
      {/* The shell's one status mark: idle draws nothing (a dot always means
          something is going on); the slot keeps the text column fixed. */}
      <span className="mt-[6px] flex h-[7px] w-[7px] shrink-0 items-center justify-center">
        <LifeMark markId="inspector-now" life={state} />
      </span>
      <span className="min-w-0">
        <span className={state === 'idle' ? 'text-ink-faint' : 'text-ink'}>{text}</span>
        {detail !== undefined && detail !== '' ? (
          <span className="block truncate font-mono text-[12px] text-ink-faint" title={detail}>{detail}</span>
        ) : null}
      </span>
    </div>
  );
});

function pendingLabel(t: ReturnType<typeof useI18n>['t'], item: Pending): string {
  if (item.kind === 'approval') return t('inspector.approvalItem', { tool: item.request.tool_name });
  const first = item.request.questions[0];
  return first?.header ?? first?.question ?? t('inspector.questionItem');
}

/** Pending approvals / questions for the focused agent, each with Review. */
export const InspectorNeedsYou = memo(function InspectorNeedsYou({
  items,
  onReview,
}: {
  items: readonly Pending[];
  onReview?: (kind: 'approval' | 'question', id: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <InspectorSection title={t('inspector.needsYou')} count={items.length} data-inspector-needs-you="">
      <ul className="space-y-1">
        {items.map((item) => {
          const id = item.kind === 'approval' ? item.request.approval_id : item.request.question_id;
          return (
            <li
              key={id}
              className="flex min-h-9 items-center gap-2 rounded-lg bg-accent-soft/60 py-1 pr-1 pl-2.5"
            >
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{pendingLabel(t, item)}</span>
              {onReview !== undefined ? (
                <button
                  type="button"
                  data-inspector-review={id}
                  onClick={() => { onReview(item.kind, id); }}
                  className="h-7 shrink-0 rounded-md px-2 text-[12px] font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                >
                  {t('inspector.review')}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </InspectorSection>
  );
});

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
