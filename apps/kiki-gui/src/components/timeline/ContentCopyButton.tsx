import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { Icon } from '../icons';

/** 12px glyph in a 28px tile, growing to the coarse-pointer touch size. */
const TILE = 'inline-flex min-h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:w-10';

/**
 * Copy a body verbatim. The glyph is the whole control: the word beside it
 * repeated what the tooltip and the aria label already say, and in a column of
 * wells those words became a second column of text to skip. State stays in the
 * control — a check on success, the label naming what it is doing while the
 * read is in flight, and a spoken failure the reader can retry from.
 */
export function CopyButton({ text, prepare, label }: { text: string; prepare?: (signal: AbortSignal) => Promise<string>; /** Names the body in the tooltip; a bare "Copy" when absent. */ label?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'reading' | 'copied' | 'failed'>('idle');
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { active.current?.abort(); }, []);
  const copy = async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState('reading');
    try {
      const value = prepare === undefined ? text : await prepare(controller.signal);
      controller.signal.throwIfAborted();
      await copyTextToClipboard(value);
      if (!controller.signal.aborted) setState('copied');
    } catch {
      if (!controller.signal.aborted) setState('failed');
    } finally {
      if (active.current === controller) active.current = undefined;
    }
  };
  // A named body beats a bare "Copy" when several tiles sit in one view, so the
  // tooltip always names what a press will take.
  const hint = state === 'copied'
    ? t('cb.copied')
    : state === 'reading'
      ? t('cb.preparing')
      : label === undefined || label === '' ? t('cb.copy') : t('cb.copyBody', { field: label });
  return <span className="inline-flex items-center gap-1">
    <button type="button" disabled={state === 'reading'} data-copy-state={state} aria-label={hint} title={hint}
      className={TILE}
      onClick={() => { void copy(); }}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={12} className={state === 'copied' ? 'text-success' : undefined} />
    </button>
    {state === 'reading' ? <button type="button" data-copy-cancel className="text-[11px] text-ink-faint underline" onClick={() => { active.current?.abort(); setState('idle'); }}>{t('common.cancel')}</button> : null}
    {state === 'failed' ? <span role="status" data-copy-failed className="text-[11px] text-danger">{t('subagent.call.copyFailed')}</span> : null}
  </span>;
}
