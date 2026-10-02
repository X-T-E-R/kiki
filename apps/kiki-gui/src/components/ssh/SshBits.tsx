/**
 * Small shared pieces of the SSH slice: the "coming soon" tag for controls
 * the server cannot take yet, and the connection state mark (dot + word).
 * State colours follow the baseline: connecting/ready neutral, failure danger,
 * idle draws nothing.
 */

import { useI18n } from '../../i18n';
import type { SshVisibleState } from '../../lib/ssh';

export function ComingSoonTag() {
  const { t } = useI18n();
  return (
    <span data-coming-soon className="shrink-0 pt-0.5 text-[11px] font-medium text-ink-faint">
      {t('st.ssh.comingSoon')}
    </span>
  );
}

export const SSH_HOST_CHIP_CLASS = 'inline-flex h-6 max-w-[14rem] items-center gap-1.5 rounded-md bg-ink/[0.05] text-[12px] text-ink-soft';

const STATE_KEY = {
  connecting: 'st.ssh.state.connecting',
  ready: 'st.ssh.state.ready',
  disconnected: 'st.ssh.state.disconnected',
  failed: 'st.ssh.state.failed',
} as const;

export function stateDotClass(state: SshVisibleState): string {
  return state === 'failed' ? 'bg-danger' : state === 'ready' ? 'bg-ink-soft' : 'bg-hairline-strong';
}

/** Dot + word; the word hides on narrow rows but stays for assistive tech. */
export function SshStateMark({ state, compact = false }: { state: SshVisibleState; compact?: boolean }) {
  const { t } = useI18n();
  const label = t(STATE_KEY[state]);
  return (
    <span
      data-ssh-state={state}
      className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${state === 'failed' ? 'text-danger' : 'text-ink-faint'}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${stateDotClass(state)}`} />
      <span className={compact ? 'sr-only' : ''}>{label}</span>
    </span>
  );
}
