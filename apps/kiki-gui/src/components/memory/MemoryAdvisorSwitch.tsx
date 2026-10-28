import { errorText } from '@kiki/session-core/i18n';
import { memoryAdvisorSettingsRoute } from '@kiki/session-core/settings';

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
 * so the model and every consent stay as saved, and it never touches the
 * memory switch itself. While the advisor still needs something (a model, an
 * OK to send) the state text becomes the way to the settings card that
 * provides it, rather than a switch that looks on and does nothing.
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
  const needsSetup = view.on && (view.kind === 'unconfigured' || view.kind === 'consent');
  const toggle = (on: boolean) => {
    void advisor.setOn(on).catch((error: unknown) => {
      pushToast({
        tone: 'error',
        text: t('memory.advisor.toggleFailed', { detail: errorText(locale, error) }),
        retry: { run: () => { toggle(on); } },
      });
    });
  };
  if (advisor.query.isError && advisor.data === undefined) return null;
  return (
    <span data-memory-advisor-switch data-memory-advisor-kind={view.kind} className="inline-flex min-w-0 items-center gap-2">
      <Toggle
        id={workspaceId === undefined ? 'memory-advisor-quick' : `memory-advisor-quick-${workspaceId}`}
        layout="bare"
        label={t('memory.advisor.switch')}
        checked={view.on}
        disabled={busy}
        onChange={toggle}
      />
      {advisor.data === undefined ? null : needsSetup ? (
        <button
          type="button"
          data-memory-advisor-setup
          onClick={() => { onNavigate(memoryAdvisorSettingsRoute(workspaceId)); }}
          className="min-h-7 truncate rounded px-1 text-[12px] font-medium text-amber-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
        >
          {t(view.kind === 'unconfigured' ? 'memory.advisor.chooseModel' : 'memory.advisor.reviewSending')}
        </button>
      ) : (
        <span data-memory-advisor-state role="status" className={`truncate text-[12px] ${TONE_TEXT[view.tone]}`}>
          {t(view.stateKey)}
        </span>
      )}
    </span>
  );
}
