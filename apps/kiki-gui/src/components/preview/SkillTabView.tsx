/**
 * Built-in skill read-only Markdown/source preview tab.
 */

import { useEffect, useState } from 'react';

import { useI18n } from '#/i18n';
import { useOptionalConnection } from '#/state/connection';
import { Markdown } from '../Markdown';
import { usePreviewReadingScroll, type PreviewScrollPosition } from './shared';

export function PreviewSkillView({
  tabKey,
  name,
  visible,
  position,
  onScrollPosition,
}: {
  readonly tabKey: string;
  readonly name: string;
  readonly visible: boolean;
  readonly position?: PreviewScrollPosition;
  readonly onScrollPosition?: (position: { top: number; left?: number }) => void;
}) {
  const { t } = useI18n();
  const client = useOptionalConnection()?.client;
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'error'; readonly message: string }
    | { readonly status: 'ready'; readonly content: string }
  >({ status: 'loading' });

  useEffect(() => {
    if (client === undefined) {
      setState({ status: 'error', message: t('diagnostics.unavailable') });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    client.readBuiltinSkill(name).then(
      (content) => { if (!cancelled) setState({ status: 'ready', content }); },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => { cancelled = true; };
  }, [client, name, attempt, t]);
  const { panelRef, onReadingReady } = usePreviewReadingScroll(visible, position, onScrollPosition);
  useEffect(() => { if (state.status === 'ready') onReadingReady(); }, [state.status, mode, onReadingReady]);

  return (
    <div
      ref={panelRef}
      role="tabpanel"
      hidden={!visible}
      className={`min-h-0 flex-1 flex-col ${visible ? 'flex' : 'hidden'}`}
      data-preview-tabpanel={tabKey}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
          {t('cap.source.builtin')} · {name} / SKILL.md
        </span>
        <span className="shrink-0 text-[11px] text-ink-faint">{t('preview.builtinSkillReadOnly')}</span>
        <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-ink/[0.05] p-0.5 text-[11px]">
          {(['rendered', 'source'] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-md-mode={option}
              onClick={() => { setMode(option); }}
              className={`rounded-[5px] px-2 py-0.5 transition-colors duration-[var(--kiki-motion-quick)] ${
                mode === option ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-faint hover:text-ink-soft'
              }`}
            >
              {t(option === 'rendered' ? 'preview.rendered' : 'preview.source')}
            </button>
          ))}
        </span>
      </div>
      <div data-preview-scroll className="min-h-0 flex-1 overflow-auto p-4">
        {state.status === 'loading' ? (
          <p role="status" className="text-[12px] text-ink-faint">{t('preview.loading')}</p>
        ) : state.status === 'error' ? (
          <div role="alert" className="text-[12px] text-danger">
            <span>{state.message}</span>{' '}
            <button type="button" onClick={() => { setAttempt((value) => value + 1); }} className="underline">
              {t('common.retry')}
            </button>
          </div>
        ) : mode === 'rendered' ? (
          <Markdown mode="static" text={state.content} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink">{state.content}</pre>
        )}
      </div>
    </div>
  );
}
