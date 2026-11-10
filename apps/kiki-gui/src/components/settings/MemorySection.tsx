import { Link } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { useMemoryAuthorityQuery } from '../memory/memoryAuthority';
import { MemoryAdvisorSettingsCard } from './MemoryAdvisorSettings';
import { MemorySettingsCard, MemoryWorkspaceSettingsCard } from './MemorySettings';

export function MemorySection() {
  const { t } = useI18n();
  const authority = useMemoryAuthorityQuery();
  // While the store is being upgraded every memory read waits or fails, so the
  // cards below would each print their own error. One line says what is going
  // on and where it is handled; the cards come back when the upgrade is done.
  if (authority.kind === 'migrating') {
    const failed = authority.state?.migration?.phase === 'failed';
    return (
      <div className="space-y-2 py-2" data-memory-settings-upgrading={failed ? 'failed' : 'running'}>
        <p className="text-[14px] font-medium text-ink">{t(failed ? 'memory.upgrade.title.failed' : 'memory.upgrade.title.running')}</p>
        <p className="max-w-[62ch] text-[12.5px] leading-5 text-ink-soft">{t(failed ? 'memory.upgrade.failedLead' : 'memory.upgrade.runningLead')}</p>
        <Link to="/memory" className="inline-block text-[12.5px] text-selected-ink hover:underline" data-memory-settings-open-upgrade>
          {t('st.memory.openUpgrade')}
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <MemorySettingsCard />
      <MemoryAdvisorSettingsCard />
      <MemoryWorkspaceSettingsCard />
    </div>
  );
}
