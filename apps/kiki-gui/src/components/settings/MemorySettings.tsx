import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import type { MemorySettings } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';

/**
 * The memory master switch, and a link to where memory is actually managed.
 * Everything else about memory (entries, scopes, inbox, history) lives on
 * /memory; duplicating it here would give the same feature two homes.
 */
export function MemorySettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['memory-settings'],
    queryFn: () => client.getMemorySettings(),
    staleTime: 15_000,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => client.patchMemorySettings({ enabled }),
    onSuccess: (next: MemorySettings) => { queryClient.setQueryData(['memory-settings'], next); },
  });
  const feedback: Feedback = toggle.isError
    ? { tone: 'error', text: t('memory.toggleFailed', { detail: errorText(locale, toggle.error) }) }
    : null;

  return (
    <SectionCard id="st-card-memory" title={t('st.memory.title')}>
      <div className="min-w-0 space-y-2" data-memory-settings>
        <SettingField label={t('memory.toggle')} help={t('st.memory.hint')}>
          <Toggle
            label={t('memory.toggle')}
            checked={settingsQuery.data?.enabled === true}
            disabled={settingsQuery.isPending || toggle.isPending}
            onChange={(next) => { toggle.mutate(next); }}
          />
        </SettingField>
        <button
          type="button"
          data-memory-settings-link
          onClick={() => { navigate('/memory'); }}
          className="text-[12px] font-medium text-accent-ink transition-colors hover:underline"
        >
          {t('st.memory.open')}
        </button>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
