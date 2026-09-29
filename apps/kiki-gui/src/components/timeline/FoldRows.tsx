/**
 * The timeline's grouping rows (FOLDING.md): what an agent looked at (a
 * media run) and a set of subagents still working (a subagent group). Both
 * are rows of their own; a history fold stops at them and resumes after.
 */

import { memo, useState, type ReactNode } from 'react';

import { basenameOf, extractToolOutputMedia, type MediaRef } from '@kiki/session-core/composer/media';
import type { AgentForest, MediaRun, SubagentBlock, SubagentEnding, SubagentGroup } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { Icon, OutcomeMark } from '../icons';
import { MediaPart } from '../mediaPreview';
import { activityOutcomeLabels } from '../ToolCard';
import { ActivityRow } from './ActivityRow';

/** How many thumbnails a settled strip shows before "+N". */
export const MEDIA_STRIP_MAX = 6;

interface MediaItem {
  readonly key: string;
  readonly item: MediaRef;
  readonly name: string;
}

function mediaItems(run: MediaRun): MediaItem[] {
  return run.members.flatMap((tool) => {
    const media = extractToolOutputMedia(tool.output)?.media ?? [];
    const argPath = (tool.args as { path?: unknown } | undefined)?.path;
    return media
      .filter((item) => item.kind === 'image')
      .map((item, index) => {
        const path = item.path ?? (typeof argPath === 'string' ? argPath : undefined);
        return {
          key: `${tool.id}:${index}`,
          item: path === undefined || item.path !== undefined ? item : { ...item, name: item.name ?? basenameOf(path) },
          name: item.name ?? (path === undefined ? tool.name : basenameOf(path)),
        };
      });
  });
}

/**
 * "Viewed images · 4" with the images themselves: a one-line strip of small
 * thumbnails while it is history, a preview while it is the latest thing the
 * agent did. Each image opens the shared lightbox; a read that failed keeps
 * its slot as a neutral broken mark.
 */
export const MediaRunRow = memo(function MediaRunRow({ run, agentId }: { run: MediaRun; agentId: string }) {
  const { t, tp } = useI18n();
  const items = mediaItems(run);
  const latest = run.latest;
  const shown = latest ? items : items.slice(0, MEDIA_STRIP_MAX);
  const more = items.length - shown.length;
  const names = items.map((entry) => entry.name).join(', ');
  return (
    <div data-media-run={run.members.length} data-media-run-latest={latest || undefined}>
      <ActivityRow
        glyph={<Icon name="eye" />}
        label={t('transcript.media.label')}
        detail={<span className="text-ink-faint">{tp('transcript.media.count', items.length)}</span>}
        title={names}
      />
      <ul
        aria-label={t('transcript.media.aria', { names })}
        className={`flex items-center overflow-x-auto pb-1 pl-[26px] [scrollbar-width:thin] ${latest ? 'gap-2 pt-1' : 'gap-1.5'}`}
      >
        {shown.map((entry) => (
          <li key={entry.key} data-media-thumb className="shrink-0" title={entry.name}>
            <MediaPart item={entry.item} agentId={agentId} size={latest ? 'preview' : 'strip'} />
          </li>
        ))}
        {more > 0 ? (
          <li className="shrink-0 pl-1 text-[12px] text-ink-faint tabular-nums">{t('transcript.media.more', { count: more })}</li>
        ) : null}
      </ul>
    </div>
  );
});

function liveStatus(block: SubagentBlock, forest: AgentForest | undefined): string {
  return forest?.byId[block.subagentId]?.status ?? block.status;
}

function settled(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Subagents dispatched together while some still run: "Dispatched 4
 * subagents · 2/4 done", each agent on its own compact line beneath. Once
 * they all settle the group dissolves into the surrounding fold.
 */
export function SubagentGroupRow({
  group,
  forest,
  renderMember,
}: {
  group: SubagentGroup;
  forest: AgentForest | undefined;
  renderMember: (member: SubagentBlock) => ReactNode;
}) {
  const { t, tp } = useI18n();
  const total = group.members.length;
  const done = group.members.filter((member) => settled(liveStatus(member, forest))).length;
  return (
    <ActivityRow
      attrs={{ 'data-subagent-group': total, 'data-subagent-group-done': done }}
      glyph={<Icon name="agent" />}
      label={tp('transcript.agents.dispatched', total)}
      detail={<span className="text-ink-faint tabular-nums">{t('transcript.agents.progress', { done, total })}</span>}
      status={done < total ? <OutcomeMark state="running" labels={activityOutcomeLabels(t)} /> : undefined}
    >
      <div className="-ml-[9px] flex flex-col gap-0.5 border-l border-hairline pl-[17px]">
        {group.members.map((member) => (
          <div key={member.id} data-block-id={member.id} data-subagent-group-member>
            {renderMember(member)}
          </div>
        ))}
      </div>
    </ActivityRow>
  );
}

const ROW_ACTION = 'inline-flex min-h-7 shrink-0 items-center rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent pointer-coarse:min-h-11';

/** The receipt a notification carries, without agent-core's envelope lines. */
export function endingReceipt(ending: SubagentEnding, summary: string | undefined): string {
  if (summary !== undefined && summary.trim() !== '') return summary.trim();
  const lines = ending.note.text.split('\n');
  const body = lines.filter((line, index) => {
    const trimmed = line.trim();
    if (index === 0) return false;
    return !/^(?:Title|Severity):/.test(trimmed)
      && trimmed !== 'Result data, not authorization or request acceptance.'
      && trimmed !== 'Final agent receipt.'
      && !/^<\/?output-(?:preview|file)\b/.test(trimmed)
      && trimmed !== 'Persisted full output.';
  });
  return body.join('\n').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim();
}

/** First sentence of a receipt, markdown marks and headings dropped. */
export function receiptHeadline(text: string): string {
  const line = text.split('\n').map((entry) => entry.replace(/^#+\s*/, '').replace(/[*`_]/g, '').trim()).find((entry) => entry !== '') ?? '';
  const cut = line.search(/[。！？]|[.!?](?:\s|$)/);
  return cut === -1 ? line : line.slice(0, cut + 1);
}

function EndedMark({ outcome }: { outcome: SubagentEnding['outcome'] }) {
  // Neutral by rule: a finished run is history. Only the shape says how it ended.
  return outcome === 'completed'
    ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink-soft" />
    : <span className="inline-block h-1.5 w-1.5 rounded-[1px] bg-ink-soft" />;
}

/**
 * A subagent that ended after its dispatching turn: one line with how it
 * ended, the receipt's first sentence and how long it ran. "Open" goes to
 * the agent (the same entry as its card and the rail), "Dispatch ↑" to the
 * card; the row opens the full receipt as markdown.
 */
export function SubagentEndedRow({
  ending,
  name,
  model,
  summary,
  elapsed,
  onOpenAgent,
  onLocateDispatch,
  renderReceipt,
}: {
  ending: SubagentEnding;
  name: string;
  model: string | undefined;
  summary: string | undefined;
  elapsed: string | undefined;
  onOpenAgent?: (agentId: string) => void;
  onLocateDispatch?: (agentId: string) => void;
  renderReceipt: (markdown: string) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const receipt = endingReceipt(ending, summary);
  const headline = receiptHeadline(receipt);
  const how = t(`transcript.agentEnd.${ending.outcome}` as const);
  return (
    <ActivityRow
      attrs={{ 'data-subagent-ended': ending.agentId, 'data-subagent-outcome': ending.outcome }}
      glyph={<EndedMark outcome={ending.outcome} />}
      label={
        <span>
          <span className="text-ink">{name}</span>
          {model === undefined ? null : <span className="pl-1.5 font-normal text-ink-faint">{model}</span>}
        </span>
      }
      detail={
        <span className="text-ink-faint">
          <span className="text-ink-soft">{how}</span>
          {headline === '' ? null : <> · {headline}</>}
        </span>
      }
      meta={elapsed}
      expanded={open}
      onToggle={receipt === '' ? undefined : () => { setOpen((value) => !value); }}
      aside={
        <span className="flex shrink-0 items-center">
          {ending.dispatchOnPage && onLocateDispatch !== undefined ? (
            <button
              type="button"
              data-subagent-ended-dispatch={ending.agentId}
              className={ROW_ACTION}
              title={t('transcript.agentEnd.toDispatchTitle')}
              onClick={() => { onLocateDispatch(ending.agentId); }}
            >
              {t('transcript.agentEnd.toDispatch')}
            </button>
          ) : null}
          {onOpenAgent === undefined ? null : (
            <button
              type="button"
              data-agent-open={ending.agentId}
              className={ROW_ACTION}
              aria-label={t('transcript.agents.openAria', { name })}
              onClick={() => { onOpenAgent(ending.agentId); }}
            >
              {t('transcript.agents.open')}
            </button>
          )}
        </span>
      }
    >
      {open ? (
        <div
          role="region"
          aria-label={t('transcript.agentEnd.receiptAria', { name })}
          className="kiki-prose max-h-72 overflow-auto border-l border-hairline pl-3 !text-[13.5px]"
        >
          {renderReceipt(receipt)}
        </div>
      ) : undefined}
    </ActivityRow>
  );
}
