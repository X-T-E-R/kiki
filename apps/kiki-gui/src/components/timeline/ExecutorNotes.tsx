import { memo, useMemo, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { ExecutorNote, TurnExecutionInfo } from '@kiki/session-core/session';
import { diffStat, type DiffHunk } from '@kiki/session-core/util';
import { useI18n } from '../../i18n';
import { DiffCard } from '../DiffCard';
import { Icon } from '../icons';
import { ActivityRow, ActivityStats, TimelineDivider } from './ActivityRow';

const PROTOCOL_SHORT: Record<string, string> = { 'acp-v1': 'ACP', acp: 'ACP', 'codex-app-server': 'app-server' };

/** Known engine ids read as their product names; anything else is shown as written. */
const EXECUTOR_NAMES: Record<string, string> = {
  'claude-acp': 'Claude Code', 'codex-app-server': 'Codex', 'codex-acp': 'Codex', 'grok-acp': 'Grok Build',
};

export function executorDisplayName(id: string): string {
  return EXECUTOR_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * External-executor provenance opening a turn (`executor.turn.metadata`).
 * `Claude Code · ACP`, plus one quiet line: how the profile instructions were
 * delivered, and — only when the record is partial — a neutral "Partial
 * record" whose tooltip reads each loss in words. Loss codes stay in the
 * DOM as data for tests and copy-paste, not as visible jargon.
 */
export const TurnExecutionBadge = memo(function TurnExecutionBadge({ execution }: { execution: TurnExecutionInfo }) {
  const { t } = useI18n();
  const executor = executorDisplayName(execution.executorId);
  const protocol = PROTOCOL_SHORT[execution.protocol] ?? execution.protocol;
  const degraded = execution.fidelity === 'degraded' || execution.losses.length > 0;
  const lossLines = execution.losses.map((code) => {
    const key = `transcript.loss.${code}` as I18nKey;
    const text = t(key);
    return text === key ? code : text;
  });
  const deliveryKey = execution.profileDelivery === undefined ? undefined
    : `transcript.exec.delivery.${execution.profileDelivery}` as I18nKey;
  const delivery = deliveryKey === undefined || t(deliveryKey) === deliveryKey ? undefined : t(deliveryKey);
  return (
    <div data-turn-execution data-profile-delivery={execution.profileDelivery}
      className="anim-enter flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-faint">
      <span title={execution.resumeMode === undefined ? undefined : t('transcript.exec.resumeMode', { mode: execution.resumeMode })}
        className="inline-flex items-center gap-1 font-medium text-ink-soft">
        <Icon name="external" size={12} className="text-ink-faint" />
        {t('transcript.exec.badge', { executor, protocol })}
      </span>
      {delivery !== undefined ? <span data-turn-delivery>· {delivery}</span> : null}
      {degraded ? (
        <span data-turn-degraded data-loss-codes={execution.losses.join(' ')} tabIndex={0}
          title={lossLines.length === 0 ? undefined : lossLines.map((line) => `· ${line}`).join('\n')}
          aria-label={[t('transcript.exec.degradedNote'), ...lossLines].join('. ')}
          className="inline-flex cursor-help items-center gap-1 rounded-[4px] underline decoration-dotted decoration-ink-faint/60 underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-accent">
          · {t('transcript.exec.degradedNote')}
        </span>
      ) : null}
    </div>
  );
});
export interface UnifiedDiffFile {
  readonly path: string;
  readonly hunks: DiffHunk[];
}

/**
 * Parse a unified diff (Codex `turn/diff/updated`) into per-file hunks the
 * native DiffCard renders. Tolerant: unknown header lines are skipped, a diff
 * without file headers becomes one unnamed file.
 */
export function parseUnifiedDiff(text: string): UnifiedDiffFile[] {
  const files: { path: string; hunks: { lo: number; ln: number; tag: 'equal' | 'insert' | 'delete'; text: string }[][] }[] = [];
  let file: (typeof files)[number] | undefined;
  let hunk: (typeof files)[number]['hunks'][number] | undefined;
  let lo = 0;
  let ln = 0;
  const ensureFile = (path: string) => { file = { path, hunks: [] }; files.push(file); hunk = undefined; };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line);
      ensureFile(match?.[1] ?? line.slice('diff --git '.length));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '');
      if (file === undefined) ensureFile(path);
      else if (path !== '/dev/null') file.path = path;
      continue;
    }
    if (line.startsWith('--- ') && hunk === undefined) continue;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header !== null) {
      if (file === undefined) ensureFile('');
      hunk = [];
      file!.hunks.push(hunk);
      lo = Number(header[1]);
      ln = Number(header[2]);
      continue;
    }
    if (hunk === undefined) continue;
    if (line.startsWith('+')) hunk.push({ lo: 0, ln: ln++, tag: 'insert', text: line.slice(1) });
    else if (line.startsWith('-')) hunk.push({ lo: lo++, ln: 0, tag: 'delete', text: line.slice(1) });
    else if (line.startsWith(' ')) hunk.push({ lo: lo++, ln: ln++, tag: 'equal', text: line.slice(1) });
  }
  return files.filter((entry) => entry.hunks.some((lines) => lines.length > 0));
}

function EngineDiff({ diff, turnLabel }: { diff: string; turnLabel: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const stat = useMemo(() => diffStat(files.flatMap((file) => file.hunks)), [files]);
  const detail = files.length === 1 ? files[0]!.path : files.length > 1 ? t('transcript.exec.turnDiffFiles', { count: files.length }) : undefined;
  return (
    <ActivityRow attrs={{ 'data-executor-note': 'diff' }} glyph={<Icon name="edit" />} label={turnLabel}
      detail={detail === undefined ? undefined : <span className="font-mono">{detail}</span>}
      stats={files.length > 0 ? <ActivityStats insertions={stat.insertions} deletions={stat.deletions} /> : undefined}
      expanded={open} onToggle={files.length === 0 ? undefined : () => { setOpen((value) => !value); }}>
      {open ? <div className="space-y-3">
        {files.map((file, index) => <div key={`${file.path}-${index}`} data-engine-diff-file={file.path} className="space-y-1">
          {files.length > 1 ? <p className="font-mono text-[12px] text-ink-soft">{file.path}</p> : null}
          <DiffCard hunks={file.hunks} />
        </div>)}
      </div> : undefined}
    </ActivityRow>
  );
}
const HINT_KEY = {
  'delivered:native_steer': 'transcript.exec.hint.delivered.native_steer',
  'delivered:next_turn_preamble': 'transcript.exec.hint.delivered.next_turn_preamble',
  queued: 'transcript.exec.hint.queued',
  undelivered: 'transcript.exec.hint.undelivered',
} as const satisfies Record<string, I18nKey>;

/**
 * One external-engine runtime fact in the timeline, reusing the native
 * shapes: an engine compaction is the same divider as a Kiki compaction, the
 * whole-turn diff is an edit activity row that opens the native DiffCard, and
 * a prompt-delivery status or unmapped update is a one-line quiet note.
 * `queued` reads as waiting, never as delivered.
 */
export const ExecutorNoteRow = memo(function ExecutorNoteRow({ note, createdAt }: { note: ExecutorNote; createdAt?: string }) {
  const { t, time } = useI18n();
  const title = time.absoluteTime(createdAt);
  switch (note.kind) {
    case 'compaction':
      return <TimelineDivider title={title} attrs={{ 'data-executor-note': 'compaction' }}>{t('transcript.exec.compacted')}</TimelineDivider>;
    case 'diff':
      return <EngineDiff diff={note.diff} turnLabel={t('transcript.exec.turnDiff')} />;
    case 'unknown':
      return <QuietNote kind="unknown" title={note.updateType === undefined ? title : `${note.updateType}${title === undefined ? '' : ` · ${title}`}`}
        icon="dash" text={t('transcript.exec.unknownUpdate')} />;
    case 'hint': {
      const key = note.status === 'delivered'
        ? note.method === 'native_steer' ? HINT_KEY['delivered:native_steer'] : HINT_KEY['delivered:next_turn_preamble']
        : note.status === 'queued' ? HINT_KEY.queued : HINT_KEY.undelivered;
      return <QuietNote kind={`hint-${note.status}`} title={title} text={t(key)}
        icon={note.status === 'delivered' ? 'check' : note.status === 'queued' ? 'clock' : 'cross'} tone={note.status === 'undelivered' ? 'warn' : 'plain'} />;
    }
  }
});

function QuietNote({ kind, text, icon, title, tone = 'plain' }: {
  kind: string; text: string; icon: 'check' | 'clock' | 'cross' | 'dash'; title?: string; tone?: 'plain' | 'warn';
}) {
  return (
    <div data-executor-note={kind} title={title} className="anim-enter flex min-h-[22px] items-center gap-2 text-[12px]">
      <span aria-hidden className={`flex h-4 w-[18px] shrink-0 items-center justify-center ${tone === 'warn' ? 'text-amber-rule' : 'text-ink-faint'}`}>
        <Icon name={icon} size={12} />
      </span>
      <span className={tone === 'warn' ? 'text-amber-ink' : 'text-ink-faint'}>{text}</span>
    </div>
  );
}
