import { errorText } from '@kiki/session-core/i18n';
import { DECISION_JUDGES_ROUTE } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { Toggle } from '../controls';
import { useMemoryAdvisor } from './useMemoryAdvisor';

const TONE_TEXT = {
  muted: 'text-ink-faint',
  ok: 'text-ink-soft',
  caution: 'text-amber-ink',
  danger: 'text-danger',
} as const;

/**
 * The advisor's one-tap switch, for page headers. It writes the mode alone,
 * so the chosen source stays as saved, and it never touches the memory
 * switch itself. While the advisor still needs a source, the state text
 * links to Who decides, where it is chosen, rather than a switch that looks
 * on and does nothing.
 *
 * A failed read never removes the switch: it degrades the status text to one
 * quiet line plus 重试, so the off switch for the very feature that may be
 * failing stays reachable during a backend incident.
 */
export function MemoryAdvisorSwitch({
  workspaceId,
  onNavigate,
}: {
  readonly workspaceId?: string;
  readonly onNavigate: (route: string) => void;
}) {
  const { t, locale } = useI18n();
  const advisor = useMemoryAdvisor(workspaceId);
  const { view } = advisor;
  const busy = advisor.query.isPending || advisor.save.isPending;
  const readFailed = advisor.query.isError;
  const needsSetup = view.on && view.kind === 'unconfigured';
  const toggle = (on: boolean) => {
    void advisor.setOn(on).catch((error: unknown) => {
      pushToast({
        tone: 'error',
        text: t('memory.advisor.toggleFailed', { detail: errorText(locale, error) }),
        retry: { run: () => { toggle(on); } },
      });
    });
  };
  return (
    <span data-memory-advisor-switch data-memory-advisor-kind={readFailed ? 'error' : view.kind} className="inline-flex min-w-0 items-center gap-2">
      <Toggle
        id={workspaceId === undefined ? 'memory-advisor-quick' : `memory-advisor-quick-${workspaceId}`}
        layout="bare"
        label={t('memory.advisor.switch')}
        checked={view.on}
        disabled={busy && !readFailed}
        onChange={toggle}
      />
      {readFailed ? (
        <span data-memory-advisor-state role="status" className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-ink-faint">
          <span className="truncate">{t('memory.advisor.loadFailed', { detail: errorText(locale, advisor.query.error) })}</span>
          <button
            type="button"
            data-memory-advisor-retry
            onClick={() => { void advisor.query.refetch(); }}
            className="shrink-0 rounded font-medium text-ink-soft underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            {t('common.retry')}
          </button>
        </span>
      ) : advisor.data === undefined ? null : needsSetup ? (
        <button
          type="button"
          data-memory-advisor-setup
          onClick={() => { onNavigate(DECISION_JUDGES_ROUTE); }}
          className="min-h-7 truncate rounded px-1 text-[12px] font-medium text-amber-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
        >
          {t('memory.advisor.chooseModel')}
        </button>
      ) : (
        <span data-memory-advisor-state role="status" className={`truncate text-[12px] ${TONE_TEXT[view.tone]}`}>
          {t(view.stateKey)}
        </span>
      )}
    </span>
  );
}
