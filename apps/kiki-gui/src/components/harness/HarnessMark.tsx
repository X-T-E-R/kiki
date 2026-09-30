import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { registerOverlay } from '../../lib/uiBusy';
import { Icon } from '../icons';
import type { SessionHarness } from './sessionHarness';

type CapabilityKey = 'image' | 'audio' | 'fork' | 'native_steering' | 'question_form' | 'plan_approval';

export const HARNESS_CAPABILITIES: readonly { readonly key: CapabilityKey; readonly label: I18nKey }[] = [
  { key: 'native_steering', label: 'harness.cap.native_steering' },
  { key: 'image', label: 'harness.cap.image' },
  { key: 'audio', label: 'harness.cap.audio' },
  { key: 'fork', label: 'harness.cap.fork' },
  { key: 'question_form', label: 'harness.cap.question_form' },
  { key: 'plan_approval', label: 'harness.cap.plan_approval' },
];

/**
 * The engine behind this session, beside the title: one quiet outlined mark
 * (`Claude Code 0.84.0`) in the same family as the temporary-session mark.
 * Opening it lists what the engine's last handshake agreed to — facts, not
 * settings — and where the engine is managed. Nothing here is a control.
 */
export function HarnessMark({ harness }: { harness: SessionHarness }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay('harness-mark');
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target) !== true) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);
  const negotiated = harness.negotiated;
  const summary = [harness.label, harness.version].filter((part) => part !== undefined).join(' ');
  return (
    <span ref={rootRef} data-harness-caps={harness.executorId} className="relative hidden shrink-0 self-center sm:inline-flex">
      <button type="button" aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog"
        title={t('harness.markTitle', { engine: summary })}
        onClick={() => { setOpen((value) => !value); }}
        className="inline-flex h-[18px] max-w-[14rem] items-center gap-1 rounded-[5px] border border-hairline-strong px-1.5 text-[11px] leading-none font-medium text-ink-soft transition-colors hover:border-ink-faint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink">
        <Icon name="external" size={12} className="shrink-0 text-ink-faint" />
        <span className="truncate">{harness.label}</span>
        {harness.version !== undefined ? <span className="shrink-0 font-mono text-[10.5px] font-normal text-ink-faint">{harness.version}</span> : null}
      </button>
      {open ? (
        <div id={panelId} role="dialog" aria-label={t('harness.panelTitle', { engine: harness.label })} data-harness-panel
          className="anim-enter absolute top-full left-0 z-40 mt-1.5 w-72 rounded-[10px] border border-hairline bg-panel p-3 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]">
          <p className="text-[12.5px] font-medium text-ink">{t('harness.panelTitle', { engine: harness.label })}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
            {[harness.executorId, harness.protocol, harness.version].filter((part) => part !== undefined && part !== '').join(' · ')}
          </p>
          {negotiated === undefined ? (
            <p className="mt-2 text-[12px] leading-snug text-ink-soft">{t('harness.notNegotiated')}</p>
          ) : (
            <ul className="mt-2 space-y-1" aria-label={t('harness.capsLabel')}>
              {HARNESS_CAPABILITIES.map(({ key, label }) => {
                const value = negotiated[key];
                const state = value === true ? 'yes' : value === false ? 'no' : 'unknown';
                return (
                  <li key={key} data-harness-cap={key} data-cap-state={state} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className={state === 'no' ? 'text-ink-faint' : 'text-ink-soft'}>{t(label)}</span>
                    <span className={`inline-flex items-center gap-1 ${state === 'yes' ? 'text-ink' : 'text-ink-faint'}`}>
                      {state === 'yes' ? <Icon name="check" size={12} /> : null}
                      {t(state === 'yes' ? 'harness.cap.yes' : state === 'no' ? 'harness.cap.no' : 'harness.cap.unknown')}
                    </span>
                  </li>
                );
              })}
              <li data-harness-cap="kiki_subagents" className="flex items-center justify-between gap-3 border-t border-hairline pt-1.5 text-[12px]">
                <span className="text-ink-soft">{t('harness.cap.kiki_subagents')}</span>
                <span className={harness.kikiSubagents ? 'text-ink' : 'text-ink-faint'}>{t(harness.kikiSubagents ? 'harness.cap.on' : 'harness.cap.off')}</span>
              </li>
            </ul>
          )}
          <p className="mt-2 text-[11.5px] leading-snug text-ink-faint">{t('harness.fromHandshake')}</p>
          <Link to="/settings/ai?tab=providers" onClick={() => { setOpen(false); }}
            className="mt-1.5 inline-flex min-h-7 items-center text-[12px] font-medium text-selected-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink">
            {t('harness.manage')}
          </Link>
        </div>
      ) : null}
    </span>
  );
}

/**
 * Codex refuses a Kiki tool call it cannot ask about. In Full access mode
 * there is no one to ask, so the note says what to switch to — shown only
 * while that combination holds.
 */
export function CodexApprovalNote() {
  const { t } = useI18n();
  return (
    <div className="px-6 pb-1.5">
      <p data-codex-mcp-note role="note"
        className="mx-auto flex max-w-[var(--kiki-chat-content-width,760px)] items-start gap-2 text-[12px] leading-snug text-ink-soft">
        <Icon name="warning" size={12} className="mt-0.5 shrink-0 text-amber-rule" />
        <span>{t('harness.codexYolo')}</span>
      </p>
    </div>
  );
}
