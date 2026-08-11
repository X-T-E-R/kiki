/**
 * Tool call card — hairline-bordered, mono 13px data, chevron expand, status
 * icon (spinner / check / ×), duration. Shell *commands* render as a dark
 * island; everything else stays on paper.
 */

import { memo, useMemo, useState, type ReactNode } from 'react';

import type { ToolInputDisplay } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import { extractEditSource, diffStat } from '../lib/diff';
import type { ToolBlock } from '../state/transcript';
import { DiffCard } from './DiffCard';

type Translate = ReturnType<typeof useI18n>['t'];
type TranslatePlural = ReturnType<typeof useI18n>['tp'];

export function toolGlyph(block: ToolBlock): string {
  const display = block.display;
  if (display !== undefined) {
    switch (display.kind) {
      case 'command':
        return '›_';
      case 'file_io':
        return display.operation === 'read'
          ? '◧'
          : display.operation === 'write' || display.operation === 'edit'
            ? '✎'
            : '⌕';
      case 'diff':
        return '±';
      case 'search':
        return '⌕';
      case 'url_fetch':
        return '⌁';
      case 'agent_call':
        return '⧉';
      case 'skill_call':
        return '✦';
      case 'todo_list':
        return '☰';
      case 'task':
      case 'task_stop':
        return '⏵';
      case 'plan_review':
        return '✎';
      case 'goal_start':
        return '◎';
      case 'generic':
        break;
    }
  }
  const name = block.name.toLowerCase();
  if (name.includes('bash') || name.includes('shell') || name.includes('cmd')) return '›_';
  if (name.includes('read')) return '◧';
  if (name.includes('write') || name.includes('edit')) return '✎';
  if (name.includes('grep') || name.includes('glob') || name.includes('search')) return '⌕';
  if (name.includes('fetch') || name.includes('web')) return '⌁';
  if (name.includes('task') || name.includes('agent')) return '⧉';
  if (name.includes('todo')) return '☰';
  return '⚙';
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
    case 'goal_start':
      return display.objective;
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

function StatusIcon({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  if (block.status === 'running') {
    return (
      <svg className="spinner h-3.5 w-3.5 text-accent" viewBox="0 0 16 16" fill="none" aria-label={t('transcript.runningAria')}>
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (block.status === 'error') {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-danger/10 text-[10px] font-bold text-danger" aria-label={t('transcript.failedAria')}>
        ×
      </span>
    );
  }
  return (
    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success/10 text-[10px] font-bold text-success" aria-label={t('transcript.doneAria')}>
      ✓
    </span>
  );
}

function CommandIsland({ command, output }: { command: string; output?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg bg-ink">
      <div className="border-b border-white/10 px-3 py-1.5 font-mono text-[12.5px] text-[#f3e9d8]">
        <span className="mr-2 text-accent">$</span>
        {command}
      </div>
      {output !== undefined ? (
        <div className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[#e8dcc4]">
          {output}
        </div>
      ) : null}
    </div>
  );
}

function OutputView({ output }: { output: unknown }) {
  const { t } = useI18n();
  if (output === undefined || output === null) return null;
  if (typeof output === 'string') {
    return (
      <pre className="max-h-72 overflow-auto rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
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
            <pre className="max-h-72 overflow-auto rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">{o.stdout}</pre>
          ) : null}
          {o.stderr !== undefined && o.stderr !== '' ? (
            <pre className="max-h-72 overflow-auto rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-danger">{o.stderr}</pre>
          ) : null}
          <p className="font-mono text-[11px] text-ink-faint">{t('tc.exit', { code: o.exit_code })}</p>
        </div>
      );
    }
    if (candidate.kind === 'text') {
      const o = output as { text: string };
      return (
        <pre className="max-h-72 overflow-auto rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">{o.text}</pre>
      );
    }
    if (candidate.kind === 'error') {
      const o = output as { message: string };
      return (
        <pre className="max-h-72 overflow-auto rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-danger">{o.message}</pre>
      );
    }
    if (candidate.kind === 'file_content') {
      const o = output as { path: string; content: string };
      return (
        <pre className="max-h-72 overflow-auto rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">{o.content}</pre>
      );
    }
  }
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">
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

export const ToolCard = memo(function ToolCard({ block }: { block: ToolBlock }) {
  const { t, tp, time } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const summary = toolSummary(block, t, tp);
  const isCommand = block.display?.kind === 'command';
  // Edit-style calls (Edit/MultiEdit/Write): hunks from display or args —
  // diffstat in the collapsed header, unified diff card in the detail view.
  const editSource = useMemo(
    () => extractEditSource(block.display, block.args),
    [block.display, block.args],
  );
  const stat = editSource !== undefined ? diffStat(editSource.hunks) : undefined;

  return (
    <div className="anim-enter overflow-hidden rounded-xl border border-hairline bg-panel">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-paper/60"
      >
        <span className="w-6 shrink-0 text-center font-mono text-[12px] text-ink-soft">
          {toolGlyph(block)}
        </span>
        <span className="shrink-0 text-[12.5px] font-semibold text-ink">{block.name}</span>
        {summary !== '' ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {stat !== undefined && (stat.insertions > 0 || stat.deletions > 0) ? (
          <span className="shrink-0 font-mono text-[10.5px]">
            <span className="text-success">+{stat.insertions}</span>
            <span className="text-ink-faint">/</span>
            <span className="text-danger">−{stat.deletions}</span>
          </span>
        ) : null}
        {block.progressText !== undefined && block.status === 'running' ? (
          <span className="max-w-40 truncate font-mono text-[10.5px] text-ink-faint">
            {block.progressText}
          </span>
        ) : null}
        {block.durationMs !== undefined ? (
          <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">
            {time.formatDuration(block.durationMs)}
          </span>
        ) : null}
        <StatusIcon block={block} />
        <span
          aria-hidden
          className={`shrink-0 text-[10px] text-ink-faint transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
      </button>

      {expanded ? (
        <div className="space-y-2 border-t border-hairline px-3 py-2.5">
          {isCommand && block.display?.kind === 'command' ? (
            <CommandIsland
              command={block.display.command}
              output={
                block.output !== undefined ? <OutputView output={block.output} /> : undefined
              }
            />
          ) : (
            <>
              {block.description !== undefined ? (
                <p className="text-[12px] text-ink-soft">{block.description}</p>
              ) : null}
              {editSource !== undefined ? (
                <div>
                  <p className="mb-1 text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                    {t('tc.changes')}
                    {editSource.path !== undefined ? (
                      <span className="font-mono font-normal normal-case"> — {editSource.path}</span>
                    ) : null}
                  </p>
                  <DiffCard hunks={editSource.hunks} />
                </div>
              ) : (
                <div>
                  <p className="mb-1 text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                    {t('tc.input')}
                  </p>
                  <pre className="max-h-60 overflow-auto rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
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
                  <p className="mb-1 text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                    {t('tc.output')}{block.isError === true ? t('tc.outputError') : ''}
                  </p>
                  <OutputView output={block.output} />
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
});
