/**
 * The shared body of a semantic tool step: facts, the things it returned,
 * a preview of its text, and the raw payload folded under "Raw data". Every
 * built-in tool renders through these same parts, so a thread send and a
 * history search differ only in what they say, never in how it is set.
 */

import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { QueryClientContext } from '@tanstack/react-query';

import type { Session } from '@kiki/protocol';

import { useHost } from '../../host';
import { openExternalUrl } from '../../host/external';
import { useI18n } from '../../i18n';
import { locateInTimeline, normalizeTurnId } from '../../lib/timelineLocate';
import { useGuardedNavigate } from '../dirtyGuard';
import { DisclosureChevron, Icon } from '../icons';
import { useMediaPreview } from '../mediaPreviewContext';
import type { SemanticContext, SemanticLink, SemanticTone, ToolSemantics } from '../toolSemantics';
import { toolRecordCopy } from '../toolRecordCopy';

export const SEMANTIC_STATE_TONE: Record<SemanticTone, string> = {
  plain: 'text-ink-faint',
  warn: 'text-amber-ink',
  danger: 'text-danger',
  accent: 'text-accent-ink',
};

/** Session titles the client already holds (the sidebar's session pages). */
function useKnownSessionTitles(): (sessionId: string) => string | undefined {
  const queryClient = useContext(QueryClientContext);
  return useCallback((sessionId: string) => {
    if (queryClient === undefined) return undefined;
    for (const [, data] of queryClient.getQueriesData({ queryKey: ['sessions'] })) {
      const pages = (data as { pages?: readonly { items?: readonly Session[] }[] } | undefined)?.pages;
      for (const page of pages ?? []) {
        const hit = page.items?.find((session) => session.id === sessionId);
        if (hit !== undefined && hit.title.trim() !== '') return hit.title;
      }
    }
    return undefined;
  }, [queryClient]);
}

export function useSemanticContext(): SemanticContext {
  const { t, tp, locale } = useI18n();
  const threadTitle = useKnownSessionTitles();
  return useMemo(() => ({ t, tp, locale, threadTitle }), [t, tp, locale, threadTitle]);
}

/**
 * Follow a semantic link: another session (optionally at a turn), a turn in
 * this timeline through the one locate entry, an agent, an app route, or an
 * external page through the host.
 */
export function useFollowLink(onOpenAgent?: (agentId: string) => void): (link: SemanticLink) => void {
  const navigate = useGuardedNavigate();
  const host = useHost();
  const { t } = useI18n();
  const currentSession = useMediaPreview()?.sessionId;
  return useCallback((link: SemanticLink) => {
    switch (link.kind) {
      case 'session': {
        const sessionId = link.sessionId ?? currentSession;
        if (sessionId === undefined) return;
        if (sessionId === currentSession && link.turn !== undefined) {
          void locateInTimeline({ kind: 'turn', turnId: normalizeTurnId(link.turn) }, { sessionId, agentId: link.agentId });
          return;
        }
        const base = link.agentId === undefined ? `/s/${sessionId}` : `/s/${sessionId}/agent/${link.agentId}`;
        navigate(link.turn === undefined ? base : `${base}?turn=${String(link.turn)}`);
        return;
      }
      case 'agent':
        if (onOpenAgent !== undefined) onOpenAgent(link.agentId);
        else if (currentSession !== undefined) navigate(`/s/${currentSession}/agent/${link.agentId}`);
        return;
      case 'route':
        navigate(link.path);
        return;
      case 'external':
        void openExternalUrl(host, link.url, t('common.popupBlocked')).catch(() => undefined);
    }
  }, [currentSession, host, navigate, onOpenAgent, t]);
}

const JUMP_SLOT = 'flex h-7 w-7 shrink-0 items-center justify-center';

/**
 * The row's trailing jump slot: a quiet arrow outside the disclosure button,
 * or the same width left empty, so every semantic row shares one right edge.
 */
export function SemanticJumpSlot({ link, onOpenAgent }: { link?: SemanticLink; onOpenAgent?: (agentId: string) => void }) {
  if (link === undefined) return <span aria-hidden data-tool-jump-slot className={JUMP_SLOT} />;
  return <SemanticJump link={link} onOpenAgent={onOpenAgent} />;
}

function SemanticJump({ link, onOpenAgent }: { link: SemanticLink; onOpenAgent?: (agentId: string) => void }) {
  const follow = useFollowLink(onOpenAgent);
  return (
    <button
      type="button"
      data-tool-jump={link.kind}
      title={link.label}
      aria-label={link.label}
      onClick={() => { follow(link); }}
      className={`${JUMP_SLOT} rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink`}
    >
      <Icon name="arrowUpRight" size={12} />
    </button>
  );
}

/** Collapsed-row detail: the object in ink, the note after it in faint type. */
export function SemanticDetailLine({ semantics }: { semantics: ToolSemantics }): ReactNode {
  if (semantics.object === undefined && semantics.note === undefined) return undefined;
  return (
    <span data-tool-semantic-detail>
      {semantics.object === undefined ? null : <span className="text-ink-soft" title={semantics.object}>{semantics.object}</span>}
      {semantics.object !== undefined && semantics.note !== undefined ? <span aria-hidden>{' · '}</span> : null}
      {semantics.note === undefined ? null : <span title={semantics.noteTitle ?? semantics.note}>{semantics.note}</span>}
    </span>
  );
}

const ITEMS_PREVIEW = 8;

/**
 * The expanded body: facts as a two-column list, returned items as a quiet
 * list whose linked rows jump, a text preview in the output well, and the raw
 * arguments and result behind their own disclosure.
 */
export function SemanticBody({
  semantics,
  onOpenAgent,
  raw,
  error,
}: {
  semantics: ToolSemantics;
  onOpenAgent?: (agentId: string) => void;
  /** The input/output wells, shown under "Raw data". */
  raw: ReactNode;
  /** A failure's full text, also shown alongside any returned content. */
  error?: string;
}) {
  const { t, locale } = useI18n();
  const follow = useFollowLink(onOpenAgent);
  const [showAll, setShowAll] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const fields = semantics.fields ?? [];
  const items = semantics.items ?? [];
  const visible = showAll ? items : items.slice(0, ITEMS_PREVIEW);
  return (
    <div data-tool-semantic-body className="space-y-2">
      {error !== undefined ? (
        <pre className="max-h-72 overflow-auto rounded-md bg-danger/[0.06] px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-danger">{error}</pre>
      ) : null}
      {fields.length > 0 ? (
        <dl data-tool-semantic-fields className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
          {fields.map((field) => (
            <div key={field.label} className="contents">
              <dt className="text-ink-faint">{field.label}</dt>
              <dd title={field.valueTitle} className={`min-w-0 break-words text-ink-soft ${field.mono === true ? 'font-mono' : ''}`}>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {items.length > 0 ? (
        <ul data-tool-semantic-items className="space-y-px">
          {visible.map((item) => {
            if (semantics.icon === 'ask') return (
              <li key={item.key} className="space-y-1 py-2 pl-[26px] pr-2 text-[13px]">
                <p className="break-words font-medium text-ink-soft">{item.secondary}</p>
                <p className="whitespace-pre-wrap break-words text-ink">{item.primary}</p>
              </li>
            );
            const body = (
              <>
                <span className="min-w-0 flex-1 truncate text-ink-soft" title={item.primary}>{item.primary}</span>
                {item.secondary === undefined || item.secondary === '' ? null : (
                  <span className="max-w-[45%] shrink-0 truncate text-ink-faint" title={item.secondary}>{item.secondary}</span>
                )}
              </>
            );
            return (
              <li key={item.key}>
                {item.link === undefined ? (
                  <div className="flex min-h-7 items-center gap-3 px-2 text-[12px]">{body}</div>
                ) : (
                  <button
                    type="button"
                    data-tool-semantic-link={item.link.kind}
                    title={item.link.label}
                    onClick={() => { follow(item.link!); }}
                    className="group/item flex min-h-7 w-full items-center gap-3 rounded-md px-2 text-left text-[12px] transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
                  >
                    {body}
                    <Icon name="arrowUpRight" size={12} className="text-ink-faint opacity-0 group-hover/item:opacity-100 group-focus-visible/item:opacity-100" />
                  </button>
                )}
              </li>
            );
          })}
          {items.length > ITEMS_PREVIEW && !showAll ? (
            <li>
              <button
                type="button"
                onClick={() => { setShowAll(true); }}
                className="min-h-7 rounded-md px-2 text-[12px] text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline"
              >
                {t('tc.sem.showAll', { count: items.length })}
              </button>
            </li>
          ) : null}
          {semantics.itemsMore === true ? <li className="px-2 text-[12px] text-ink-faint">{t('tc.sem.more')}</li> : null}
        </ul>
      ) : null}
      {semantics.previewNotice !== undefined ? (
        <p data-tool-preview-notice className="text-[12px] whitespace-pre-wrap text-ink-faint">{semantics.previewNotice}</p>
      ) : null}
      {(error === undefined || semantics.previewFull !== undefined) && semantics.preview !== undefined ? (
        <div>
          <pre data-tool-semantic-preview className="max-h-60 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-soft">
            {showFull ? semantics.previewFull ?? semantics.preview : semantics.preview}
          </pre>
          {semantics.previewFull !== undefined && semantics.previewFull !== semantics.preview ? (
            <div className="text-[12px] text-ink-faint">
              {!showFull ? <span>{toolRecordCopy('displayOmitted', locale)} · </span> : null}
              <button type="button" data-tool-preview-full aria-expanded={showFull}
                onClick={() => { setShowFull((value) => !value); }}
                className="min-h-7 rounded-md px-2 underline-offset-2 transition-colors hover:text-ink hover:underline">
                {toolRecordCopy(showFull ? 'collapse' : 'showFull', locale)}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div>
        <button
          type="button"
          data-tool-raw-toggle
          aria-expanded={rawOpen}
          onClick={() => { setRawOpen((value) => !value); }}
          className="flex min-h-7 items-center gap-1.5 rounded-md px-2 -ml-2 text-[12px] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
        >
          <DisclosureChevron open={rawOpen} className="text-ink-faint" />
          {t('tc.sem.raw')}
        </button>
        {rawOpen ? <div data-tool-raw className="space-y-2 pt-1.5">{raw}</div> : null}
      </div>
    </div>
  );
}
