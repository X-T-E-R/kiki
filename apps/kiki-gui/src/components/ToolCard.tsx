/**
 * Tool step — one timeline line (glyph, verb, target, ±stats, duration,
 * status) that expands in place to its diff/input/output. No card frame:
 * the output wells are the only surface. Shell *commands* expand to a dark
 * island; everything else stays on paper.
 *
 * The memory tools are quieter still and render through `MemoryToolRow`.
 */

import { memo, useMemo, useState, type ReactNode } from 'react';

import type { ToolInputDisplay } from '@kiki/protocol';

import { extractToolOutputMedia } from '@kiki/session-core/composer/media';
import type { ToolBlock } from '@kiki/session-core/session';
import { describeError, extractEditSource, diffStat } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { DiffCard } from './DiffCard';
import { isMemoryToolName, MemoryToolRow } from './MemoryToolRow';
import { FilePathLink, MediaPartList } from './mediaPreview';
import { Icon, OutcomeMark, type IconName } from './icons';
import { ActivityRow, ActivityStats, type ActivityTone } from './timeline/ActivityRow';

type Translate = ReturnType<typeof useI18n>['t'];
type TranslatePlural = ReturnType<typeof useI18n>['tp'];

/**
 * Which drawn icon names a tool's KIND of action. Several tools share one
 * picture on purpose (Read and Glob both "look"; every write is the pencil):
 * the icon answers "what sort of thing happened", the label names the tool.
 */
export function toolIcon(block: ToolBlock): IconName {
  const display = block.display;
  if (display !== undefined) {
    switch (display.kind) {
      case 'command':
        return 'terminal';
      case 'file_io':
        return display.operation === 'read'
          ? 'read'
          : display.operation === 'write' || display.operation === 'edit'
            ? 'edit'
            : 'search';
      case 'diff':
      case 'plan_review':
        return 'edit';
      case 'search':
        return 'search';
      case 'url_fetch':
        return 'web';
      case 'agent_call':
        return 'agent';
      case 'skill_call':
        return 'skill';
      case 'todo_list':
        return 'plan';
      case 'task':
      case 'task_stop':
        return 'task';
      case 'plan_enter':
        return 'plan';
      case 'goal_start':
        return 'goal';
      case 'external_permission':
        return 'gate';
      case 'generic':
        break;
    }
  }
  const name = block.name.toLowerCase();
  if (name.includes('bash') || name.includes('shell') || name.includes('cmd')) return 'terminal';
  if (name.includes('read')) return 'read';
  if (name.includes('write') || name.includes('edit')) return 'edit';
  if (name.includes('grep') || name.includes('glob') || name.includes('search')) return 'search';
  if (name.includes('fetch') || name.includes('web')) return 'web';
  if (name.includes('task') || name.includes('agent')) return 'agent';
  if (name.includes('todo')) return 'plan';
  return 'tool';
}

/** The one-line "key argument" summary shown on the collapsed card. */
export function toolSummary(block: ToolBlock, t: Translate, tp: TranslatePlural): string {
  const display = block.display;
  if (display !== undefined) return displaySummary(display, t, tp);
  const fromArgs = argsSummary(block.args);
  if (fromArgs !== undefined) return fromArgs;
  if (block.argsText !== '') {
    return block.argsText.length > 90 ? `${block.argsText.slice(0, 90)}…` : block.argsText;
  }
  return block.description ?? '';
}

/**
 * A failed call's collapsed summary IS the failure (deepseek-harness's
 * errorSummary, Apache-2.0): the first line of the error output, shown in the
 * danger color without requiring expansion. undefined when no text is usable.
 */
/** The untruncated counterpart of toolErrorSummary, for hover tooltips. */
export function toolErrorFullText(block: ToolBlock): string | undefined {
  if (block.status !== 'error') return undefined;
  const output = block.output;
  // Only text or structured error payloads carry a readable failure.
  if (typeof output !== 'string' && (typeof output !== 'object' || output === null)) return undefined;
  return describeError(output);
}

export function toolErrorSummary(block: ToolBlock): string | undefined {
  const text = toolErrorFullText(block);
  if (text === undefined) return undefined;
  const line = (text.split('\n', 1)[0] ?? '').trim();
  return line === '' ? undefined : line;
}

function displaySummary(display: ToolInputDisplay, t: Translate, tp: TranslatePlural): string {
  switch (display.kind) {
    case 'command':
      return display.command;
    case 'file_io':
      return `${display.operation} ${display.path}`;
    case 'diff':
      return display.path;
    case 'search':
      return display.scope !== undefined ? `${display.query} — ${display.scope}` : display.query;
    case 'url_fetch':
      return display.url;
    case 'agent_call':
      return display.agent_name;
    case 'skill_call':
      return display.args !== undefined ? `${display.skill_name} ${display.args}` : display.skill_name;
    case 'todo_list':
      return tp('tc.todoItems', display.items.length);
    case 'task':
      return display.description;
    case 'task_stop':
      return display.task_description;
    case 'plan_review':
      return display.path !== undefined ? t('tc.planPath', { path: display.path }) : t('tc.plan');
    case 'plan_enter':
      return t('tc.planEnter');
    case 'goal_start':
      return display.objective;
    case 'external_permission':
      return display.summary;
    case 'generic':
      return display.summary;
  }
}

function argsSummary(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['command', 'path', 'file_path', 'query', 'url', 'pattern', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') {
      return value.length > 110 ? `${value.slice(0, 110)}…` : value;
    }
  }
  return undefined;
}

function isShellCommandName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('bash') || lower.includes('shell') || lower.includes('cmd');
}

function hasCommandSummary(block: ToolBlock, summary: string): boolean {
  if (block.display?.kind === 'command') return summary !== '';
  if (!isShellCommandName(block.name) || typeof block.args !== 'object' || block.args === null) return false;
  const command = (block.args as Record<string, unknown>)['command'];
  return typeof command === 'string' && command !== '' && summary !== '';
}

/**
 * The outcome mark, only when there is an outcome worth marking. Success is
 * the common case and gets NO mark: a column of ticks is noise that trains the
 * eye to skip the column, and then a real failure in it gets skipped too.
 * A done row still announces itself to assistive tech through a visually
 * hidden label, so the silence is visual only.
 */
function StatusIcon({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  const reasonText =
    block.status === 'stopped' && typeof block.output === 'string' && block.output.trim() !== ''
      ? block.output
      : block.status === 'stopped' ? t('transcript.stopped') : undefined;
  return (
    <OutcomeMark
      state={
        block.status === 'running' ? 'running'
          : block.status === 'error' ? 'failed'
            : block.status === 'stopped' ? 'stopped' : 'done'
      }
      labels={activityOutcomeLabels(t)}
      title={reasonText}
    />
  );
}

/** The four outcome labels every activity row speaks, from one i18n source. */
export function activityOutcomeLabels(t: Translate) {
  return {
    running: t('transcript.runningAria'),
    failed: t('transcript.failedAria'),
    stopped: t('transcript.stoppedAria'),
    done: t('transcript.doneAria'),
  };
}

/**
 * Whether a finished duration earns the column. Sub-2s successes are the
 * common read/grep/edit rhythm and their numbers only add a column to skip;
 * a slow step, a failure, a stop, or a still-unknown timing always shows.
 */
export const DURATION_WORTH_SHOWING_MS = 2_000;

function CommandIsland({ command, output }: { command: string; output?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[10px] bg-shell">
      <div className="px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-shell-ink-strong">
        <span className="mr-1 text-shell-ink-soft select-none">$ </span>
        {command}
      </div>
      {output !== undefined ? (
        <div className="max-h-72 overflow-auto border-t border-shell-hairline px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-shell-ink">
          {output}
        </div>
      ) : null}
    </div>
  );
}

/** Output wells: one flat surface a tone off the page, no frame. Inside the
 * dark command island the well dissolves into the island itself. */
function wellClass(island: boolean, tone: 'plain' | 'danger' = 'plain'): string {
  if (island) {
    return `whitespace-pre-wrap font-mono text-[12px] leading-relaxed ${tone === 'danger' ? 'text-shell-danger' : ''}`;
  }
  return `max-h-72 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap ${
    tone === 'danger' ? 'bg-danger/[0.06] text-danger' : 'bg-panel text-ink'
  }`;
}

function OutputView({ output, agentId, island = false }: { output: unknown; agentId: string; island?: boolean }) {
  const { t } = useI18n();
  if (output === undefined || output === null) return null;
  // Engine media results (ReadMediaFile & friends) arrive as raw content-part
  // arrays; render their images as thumbnails instead of serialized JSON.
  const mediaOutput = extractToolOutputMedia(output);
  if (mediaOutput !== undefined) {
    return (
      <div className="space-y-2">
        {mediaOutput.text !== '' ? (
          <pre className={wellClass(island)}>
            {mediaOutput.text}
          </pre>
        ) : null}
        <MediaPartList media={mediaOutput.media} agentId={agentId} />
      </div>
    );
  }
  if (typeof output === 'string') {
    return (
      <pre className={wellClass(island)}>
        {output}
      </pre>
    );
  }
  if (typeof output === 'object') {
    const candidate = output as { kind?: unknown };
    if (candidate.kind === 'command_output') {
      const o = output as { exit_code: number; stdout?: string; stderr?: string };
      return (
        <div className="space-y-1">
          {o.stdout !== undefined && o.stdout !== '' ? (
            <pre className={wellClass(island)}>{o.stdout}</pre>
          ) : null}
          {o.stderr !== undefined && o.stderr !== '' ? (
            <pre className={wellClass(island, 'danger')}>{o.stderr}</pre>
          ) : null}
          <p className={`text-[12px] ${island ? 'text-shell-ink-soft' : 'text-ink-faint'}`}>{t('tc.exit', { code: o.exit_code })}</p>
        </div>
      );
    }
    if (candidate.kind === 'text') {
      const o = output as { text: string };
      return (
        <pre className={wellClass(island)}>{o.text}</pre>
      );
    }
    if (candidate.kind === 'error') {
      const o = output as { message: string };
      return (
        <pre className={wellClass(island, 'danger')}>{o.message}</pre>
      );
    }
    if (candidate.kind === 'file_content') {
      const o = output as { path: string; content: string };
      return (
        <pre className={wellClass(island)}>{o.content}</pre>
      );
    }
  }
  return (
    <pre className={wellClass(island)}>
      {truncateJson(output, t('tc.truncated'))}
    </pre>
  );
}

function truncateJson(value: unknown, truncatedNote: string, limit = 6000): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? String(value);
    return json.length > limit ? `${json.slice(0, limit)}\n${truncatedNote}` : json;
  } catch {
    return String(value);
  }
}

export const ToolCard = memo(function ToolCard({
  block,
  agentId = 'main',
  agentNames,
  onOpenAgent,
  nested = false,
}: {
  block: ToolBlock;
  agentId?: string;
  /** subagentId → display name, so agentRef chips read as names, not ids. */
  agentNames?: ReadonlyMap<string, string>;
  onOpenAgent?: (agentId: string) => void;
  /** Rendered inside a folded read run's spine. */
  nested?: boolean;
}) {
  const { t, tp, time } = useI18n();
  const [expanded, setExpanded] = useState(false);
  // Memory stays quieter than a tool step: one line with View / Undo instead of
  // this header and its input/output wells. Routed here so every mount agrees.
  const memoryRow = isMemoryToolName(block.name);
  const errorSummary = toolErrorSummary(block);
  const errorTitle = toolErrorFullText(block) ?? errorSummary;
  const summary = toolSummary(block, t, tp);
  const isCommand = block.display?.kind === 'command';
  const keepCommandSummary = hasCommandSummary(block, summary);
  // File-carrying displays get a clickable path in the collapsed summary.
  const displayPath =
    block.display !== undefined &&
    (block.display.kind === 'file_io' || block.display.kind === 'diff')
      ? block.display.path
      : undefined;
  // Edit-style calls (Edit/MultiEdit/Write): hunks from display or args —
  // diffstat in the collapsed header, unified diff card in the detail view.
  const editSource = useMemo(
    () => extractEditSource(block.display, block.args),
    [block.display, block.args],
  );
  const stat = editSource !== undefined ? diffStat(editSource.hunks) : undefined;

  if (memoryRow) return <MemoryToolRow block={block} />;

  const target = keepCommandSummary ? (
    <span className="font-mono">{summary}</span>
  ) : errorSummary !== undefined ? (
    <span title={errorTitle} className="font-mono">{errorSummary}</span>
  ) : block.status === 'stopped' ? (
    <span
      title={typeof block.output === 'string' && block.output.trim() !== '' ? block.output : t('transcript.stopped')}
    >
      {typeof block.output === 'string' && block.output.trim() !== ''
        ? `${t('transcript.stopped')} — ${block.output.split('\n', 1)[0]}`
        : t('transcript.stopped')}
    </span>
  ) : displayPath !== undefined ? (
    // The label already names the action (Read / Edit / Glob); the display's
    // operation word would say it a second time, so the path stands alone.
    <span className="font-mono">
      <FilePathLink path={displayPath} />
    </span>
  ) : block.progressText !== undefined && block.status === 'running' ? (
    <span className="text-ink-faint">{block.progressText}</span>
  ) : summary !== '' ? (
    <span className="font-mono">{summary}</span>
  ) : undefined;
  const label = 'mb-1 text-[12px] font-medium text-ink-faint';

  // Tone comes from the outcome, not the tool: a failure lights the whole
  // line, a stop washes it amber, success stays as quiet as a Read.
  const tone: ActivityTone =
    block.status === 'error' ? 'danger' : block.status === 'stopped' ? 'warn' : 'plain';
  // Only a frame-measured duration is this tool's own; a turn-level fallback
  // is never passed off as runtime. An unknown duration leaves the column
  // empty in every state — a dash placeholder next to the outcome mark read
  // as two unexplained symbols.
  const frameDuration =
    block.durationMs !== undefined && block.durationSource === 'frame' ? block.durationMs : undefined;
  const durationMeta =
    block.status === 'running' || frameDuration === undefined
      ? undefined
      : block.status === 'done' && frameDuration < DURATION_WORTH_SHOWING_MS
        ? undefined
        : time.formatDuration(frameDuration);
  return (
    <ActivityRow
      nested={nested}
      attrs={{ 'data-tool': true, 'data-tool-id': block.toolCallId }}
      glyph={<Icon name={toolIcon(block)} />}
      tone={tone}
      label={block.name}
      detail={target}
      expanded={expanded}
      onToggle={() => { setExpanded((value) => !value); }}
      stats={
        stat !== undefined && (stat.insertions > 0 || stat.deletions > 0)
          ? <ActivityStats insertions={stat.insertions} deletions={stat.deletions} />
          : undefined
      }
      meta={durationMeta}
      status={<StatusIcon block={block} />}
    >
      {expanded ? (
        // Expands in place under the line; no frame of its own — the wells
        // inside carry the only surface.
        <div className="space-y-2.5">
          {isCommand && block.display?.kind === 'command' ? (
            <CommandIsland
              command={block.display.command}
              output={
                block.output !== undefined ? <OutputView output={block.output} agentId={agentId} island /> : undefined
              }
            />
          ) : (
            <>
              {block.description !== undefined ? (
                <p className="text-[13px] text-ink-soft">{block.description}</p>
              ) : null}
              {editSource !== undefined ? (
                <div>
                  {editSource.path !== undefined && editSource.path !== displayPath ? (
                    <p className={label}>
                      {t('tc.changes')}
                      <span className="font-mono font-normal">
                        {' — '}
                        <FilePathLink path={editSource.path} />
                      </span>
                    </p>
                  ) : null}
                  <DiffCard hunks={editSource.hunks} />
                </div>
              ) : (
                <div>
                  <p className={label}>{t('tc.input')}</p>
                  <pre className="max-h-60 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
                    {block.args !== undefined
                      ? truncateJson(block.args, t('tc.truncated'))
                      : block.argsText !== ''
                        ? block.argsText
                        : t('tc.noInput')}
                  </pre>
                </div>
              )}
              {block.output !== undefined ? (
                <div>
                  <p className={label}>
                    {t('tc.output')}{block.isError === true ? t('tc.outputError') : ''}
                  </p>
                  <OutputView output={block.output} agentId={agentId} />
                </div>
              ) : null}
              {block.agentRefs !== undefined && block.agentRefs.length > 0 && onOpenAgent !== undefined ? (
                <div>
                  <p className={label}>{t('tc.spawnedAgents')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {block.agentRefs.map((ref) => (
                      <button
                        key={ref.agentId}
                        type="button"
                        onClick={() => { onOpenAgent(ref.agentId); }}
                        title={ref.agentId}
                        className="min-h-7 rounded-md px-2.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
                      >
                        {t('tc.openSpawnedAgent', { name: agentNames?.get(ref.agentId) ?? ref.agentId })}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : undefined}
    </ActivityRow>
  );
});
