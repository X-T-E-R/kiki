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
import type { I18nKey } from '@kiki/session-core/i18n';

import { extractToolOutputMedia } from '@kiki/session-core/composer/media';
import type { ToolBlock } from '@kiki/session-core/session';
import { describeError, extractEditSource, diffStat } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { toolDisplayName } from '../lib/pluginCatalog';
import { ContentContinuation, DISPLAY_ROOTS, EDIT_ROOTS, frameContentSource, INPUT_ROOTS, INPUT_TEXT_ROOTS, OUTPUT_ROOTS } from './ContentContinuation';
import { DiffCard } from './DiffCard';
import { isMemoryToolName, MemoryToolRow } from './MemoryToolRow';
import { MediaJobView, readMediaJobFromToolResult } from './media/MediaJobView';
import { FilePathLink, MediaPartList } from './mediaPreview';
import { Icon, OutcomeMark, type IconName } from './icons';
import { ActivityRow, ActivityStats, type ActivityTone } from './timeline/ActivityRow';
import { useFindReveal } from './timeline/findReveal';
import {
  SEMANTIC_STATE_TONE,
  SemanticBody,
  SemanticDetailLine,
  SemanticJumpSlot,
  useSemanticContext,
} from './timeline/ToolSemanticParts';
import { describeTool, toolPayloadIncomplete } from './toolSemantics';
import { toolRecordCopy } from './toolRecordCopy';
import { LoadedToolText, recordText } from './timeline/LoadedToolText';
import { CopyButton } from './timeline/SubagentInvocationView';

type Translate = ReturnType<typeof useI18n>['t'];
type TranslatePlural = ReturnType<typeof useI18n>['tp'];

/** The engine's bridge for dynamically loaded tools (MCP, plugin, deferred). */
const CALL_TOOL_BRIDGE = 'CallTool';

/**
 * The tool a row should be labelled with. While the model streams a bridged
 * call, the frame is named `CallTool` and its argument text reads
 * `{"name":"plugin__x__y","arguments":{…}}`; the engine swaps in the real
 * name only once the call starts. Read the inner name as soon as it is
 * complete in the stream, so the row never flashes the bridge's name.
 * Undefined means the name has not streamed yet.
 */
export function resolvedToolName(block: Pick<ToolBlock, 'name' | 'argsText' | 'args'>): string | undefined {
  if (block.name !== CALL_TOOL_BRIDGE) return block.name;
  const fromArgs = typeof block.args === 'object' && block.args !== null
    ? (block.args as Record<string, unknown>)['name']
    : undefined;
  if (typeof fromArgs === 'string' && fromArgs !== '') return fromArgs;
  const match = /"name"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(block.argsText);
  return match?.[1];
}

/** The streamed `arguments` object text of a bridged call, without the envelope. */
function bridgedArgsText(text: string): string {
  const match = /"arguments"\s*:\s*/.exec(text);
  if (match === null) return '';
  const inner = text.slice(match.index + match[0].length).trimEnd();
  return inner.endsWith('}}') ? inner.slice(0, -1) : inner;
}

/** The bridged call's own arguments, for the summary and the input well. */
function bridgedArgs(block: ToolBlock): unknown {
  if (block.name !== CALL_TOOL_BRIDGE || typeof block.args !== 'object' || block.args === null) return block.args;
  return (block.args as Record<string, unknown>)['arguments'] ?? block.args;
}

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

/** The translated sentence for a failure the engine reported with a stable code. */
export function toolErrorCodeText(block: ToolBlock, t: Translate): string | undefined {
  if (block.errorCode === undefined) return undefined;
  const key = `tc.errorCode.${block.errorCode}` as I18nKey;
  const text = t(key);
  return text === key ? undefined : text;
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
  // The media plugin's `generate` result: .
  // A short generation shows its files right here; a long one shows where it
  // got to, with the same honesty rules the management view uses. Drawn
  // before the string branch so a serialized job is never shown as raw JSON.
  const mediaJob = readMediaJobFromToolResult(output);
  if (mediaJob !== undefined) {
    return <MediaJobView job={mediaJob} agentId={agentId} />;
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
  return <LoadedToolText text={recordText(output)} className={wellClass(island)} copy={island} />;
}

export const ToolCard = memo(function ToolCard({
  block: sourceBlock,
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
  useFindReveal(sourceBlock.id, expanded, setExpanded);
  // A bridged call reads as the tool it calls, from the first streamed name
  // on; until that name has streamed the row says "Calling a tool".
  const bridged = sourceBlock.name === CALL_TOOL_BRIDGE;
  const realName = resolvedToolName(sourceBlock);
  const block: ToolBlock = bridged
    ? { ...sourceBlock, name: realName ?? sourceBlock.name, args: bridgedArgs(sourceBlock), argsText: realName === undefined ? '' : bridgedArgsText(sourceBlock.argsText) }
    : sourceBlock;
  // Bounded bodies (a huge arg text, a huge output) arrive cut; the refs that
  // continue them belong to this frame, and the reading areas below ask only
  // for the field roots they actually show.
  const frameSource = frameContentSource(block);
  // Memory stays quieter than a tool step: one line with View / Undo instead of
  // this header and its input/output wells. Routed here so every mount agrees.
  const memoryRow = isMemoryToolName(block.name);
  // A failure with a known code reads in the user's words; the engine's own
  // text stays in the tooltip.
  const codedError = block.status === 'error' ? toolErrorCodeText(block, t) : undefined;
  const errorSummary = codedError ?? toolErrorSummary(block);
  const engineError = toolErrorFullText(block);
  const errorTitle = codedError === undefined ? engineError ?? errorSummary
    : engineError === undefined ? codedError : `${codedError}

${engineError}`;
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
  // Built-in tools say what they did in their own terms (a thread, a task, a
  // history hit); the raw payload stays one disclosure away.
  const semanticContext = useSemanticContext();
  const semantics = useMemo(
    () => (memoryRow || (bridged && realName === undefined) ? undefined : describeTool(block, semanticContext)),
    [memoryRow, bridged, realName, block, semanticContext],
  );

  if (memoryRow) return <MemoryToolRow block={block} />;

  const target = keepCommandSummary ? (
    <span className="font-mono">{summary}</span>
  ) : errorSummary !== undefined ? (
    <span title={errorTitle} className={codedError === undefined ? 'font-mono' : undefined}>{errorSummary}</span>
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
  const inputWell = (
    <div>
      <p className={label}>{t('tc.input')}</p>
      <LoadedToolText text={block.args !== undefined ? recordText(block.args) : block.argsText || t('tc.noInput')} />
      {/* The well shows the parsed args when they exist and the streamed text
          otherwise, so it continues whichever of the two it is showing. */}
      <ContentContinuation
        source={frameSource}
        roots={block.args === undefined ? INPUT_TEXT_ROOTS : INPUT_ROOTS}
        label={t('tc.input')}
        className="mt-1"
      />
    </div>
  );
  const outputWell = (
    <div>
      <div className="mb-1 flex items-center justify-between text-[12px] font-medium text-ink-faint">
        <span>{t('tc.output')}{block.isError === true ? t('tc.outputError') : ''}</span>
        {block.output === undefined ? null : <CopyButton text={recordText(block.output)} />}
      </div>
      {toolPayloadIncomplete(block.output) ? <p data-tool-payload-status className="text-[12px] text-ink-faint">{toolRecordCopy('payloadTruncated', semanticContext.locale)}</p> : null}
      {block.output === undefined ? <p className="text-[12px] text-ink-faint">{toolRecordCopy('notLoaded', semanticContext.locale)}</p>
        : <OutputView output={block.output} agentId={agentId} />}
      <ContentContinuation source={frameSource} roots={OUTPUT_ROOTS} label={t('tc.output')} className="mt-1" />
    </div>
  );

  if (semantics !== undefined) {
    // One skeleton for every built-in tool: the verb, what it acted on, the
    // outcome in the trailing column; failure, stop and progress read exactly
    // as they do on any other step.
    const settled = block.status === 'done';
    const semanticDetail = errorSummary !== undefined ? (
      // The failure itself, in the row's own type: danger colour only.
      <span title={errorTitle}>{errorSummary}</span>
    ) : block.status === 'stopped'
      ? target
      : semantics.object === undefined && semantics.note === undefined && block.status === 'running' && block.progressText !== undefined
        ? <span className="text-ink-faint">{block.progressText}</span>
        : <SemanticDetailLine semantics={semantics} />;
    // One trailing fact column: the count, the outcome word, or (when the
    // tool states neither) the duration. Every semantic row keeps the same
    // mark, chevron and jump slots after it, so the column has one right edge.
    const count = settled ? semantics.count : undefined;
    const state = settled ? semantics.state : undefined;
    const fact = count === undefined && state === undefined ? durationMeta : (
      <span data-tool-fact className="font-sans tabular-nums">
        {count === undefined ? null : <span data-tool-count>{count}</span>}
        {count !== undefined && state !== undefined ? <span aria-hidden className="text-ink-faint">{' · '}</span> : null}
        {state === undefined ? null : <span data-tool-state className={SEMANTIC_STATE_TONE[state.tone]}>{state.text}</span>}
      </span>
    );
    return (
      <ActivityRow
        nested={nested}
        attrs={{ 'data-tool': true, 'data-tool-id': block.toolCallId, 'data-tool-semantic': block.name }}
        glyph={<Icon name={semantics.icon} />}
        tone={tone}
        label={<span title={block.name}>{semantics.verb}</span>}
        detail={semanticDetail}
        expanded={expanded}
        onToggle={() => { setExpanded((value) => !value); }}
        layout={block.name === 'AskUserQuestion' ? 'question' : undefined}
        meta={block.name === 'AskUserQuestion' ? <span className="inline-flex items-center gap-1">{fact}<StatusIcon block={block} /></span> : fact}
        metaWidth="auto"
        status={block.name === 'AskUserQuestion' ? undefined : <StatusIcon block={block} />}
        aside={block.name === 'AskUserQuestion' ? undefined : <SemanticJumpSlot link={semantics.link} onOpenAgent={onOpenAgent} />}
      >
        {expanded ? (
          <>
            <SemanticBody
              semantics={semantics}
              onOpenAgent={onOpenAgent}
              error={block.status === 'error' ? errorTitle : undefined}
              raw={<>{inputWell}{outputWell}</>}
            />
            {/* The semantic body names the outcome; the fields behind it are
                still the frame's own, so their controls stay at its tail
                instead of hiding behind the raw disclosure. */}
            <div className="space-y-1 pt-1">
              <ContentContinuation
                source={frameSource}
                roots={EDIT_ROOTS}
                label={editSource === undefined ? t('tc.input') : t('tc.changes')}
              />
              <ContentContinuation source={frameSource} roots={OUTPUT_ROOTS} label={t('tc.output')} />
            </div>
          </>
        ) : undefined}
      </ActivityRow>
    );
  }

  return (
    <ActivityRow
      nested={nested}
      attrs={{ 'data-tool': true, 'data-tool-id': block.toolCallId }}
      glyph={<Icon name={toolIcon(block)} />}
      tone={tone}
      // Plugin and MCP tools read by their own name; the runtime id
      // (`plugin__<id>__<tool>`) stays available on hover.
      label={bridged && realName === undefined ? t('tc.callingTool') : <span title={block.name}>{toolDisplayName(block.name)}</span>}
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
        <div className="space-y-2">
          {isCommand && block.display?.kind === 'command' ? (
            <>
              <CommandIsland
                command={block.display.command}
                output={
                  block.output !== undefined ? <OutputView output={block.output} agentId={agentId} island /> : undefined
                }
              />
              {/* Controls stay on paper under the island: the command line and
                  the output below it are the two bodies this card reads. */}
              <ContentContinuation source={frameSource} roots={DISPLAY_ROOTS} label={t('transcript.content.command')} />
              {block.output === undefined ? null : (
                <ContentContinuation source={frameSource} roots={OUTPUT_ROOTS} label={t('tc.output')} />
              )}
            </>
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
                  {/* The diff is built from this frame's display/args, so it is
                      those fields that continue the hunks shown. */}
                  <ContentContinuation
                    source={frameSource}
                    roots={EDIT_ROOTS}
                    label={t('tc.changes')}
                    className="mt-1"
                  />
                </div>
              ) : inputWell}
              {outputWell}
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
                        className="min-h-7 rounded-md px-3 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
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
