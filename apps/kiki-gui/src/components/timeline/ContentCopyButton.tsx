import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { Icon } from '../icons';

const TILE_ICON = 'inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const TILE_LABELED = 'inline-flex min-h-7 min-w-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-hairline bg-paper px-2 text-[12px] leading-[16px] font-normal text-ink-soft transition-colors hover:border-hairline-strong hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3';

export function CopyButton({
  text,
  prepare,
  label,
  showLabel = false,
  visibleLabel,
  className = '',
}: {
  text: string;
  prepare?: (signal: AbortSignal) => Promise<string>;
  label?: string;
  showLabel?: boolean;
  visibleLabel?: string;
  className?: string;
}) {
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
  const hint = state === 'copied'
    ? t('cb.copied')
    : state === 'reading'
      ? t('cb.preparing')
      : label === undefined || label === '' ? t('cb.copy') : t('cb.copyBody', { field: label });
  const textLabel = state === 'copied'
    ? t('cb.copied')
    : state === 'reading'
      ? t('cb.preparing')
      : (visibleLabel ?? t('cb.copy'));
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={state === 'reading'}
        data-copy-state={state}
        aria-label={hint}
        title={hint}
        className={`${showLabel ? TILE_LABELED : TILE_ICON} ${className}`.trimEnd()}
        onClick={() => { void copy(); }}
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={12} className={state === 'copied' ? 'text-success' : undefined} />
        {showLabel ? <span>{textLabel}</span> : null}
      </button>
      {state === 'reading' ? (
        <button
          type="button"
          data-copy-cancel
          className="inline-flex min-h-7 items-center px-1 text-[12px] leading-[16px] font-normal text-ink-faint underline pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          onClick={() => { active.current?.abort(); setState('idle'); }}
        >
          {t('common.cancel')}
        </button>
      ) : null}
      {state === 'failed' ? (
        <span role="status" data-copy-failed className="text-[12px] leading-[16px] font-normal text-danger">
          {t('subagent.call.copyFailed')}
        </span>
      ) : null}
    </span>
  );
}
