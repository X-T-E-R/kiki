import { useState } from 'react';

import { SETTINGS_TRANSFER_CATEGORIES, type SettingsTransferCategory } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { SectionCard } from '../SectionCard';
import { Hint } from '../../controls';
import { SECONDARY_BUTTON } from '../../ui';
import { SettingsTransferPanel } from './SettingsTransferPanel';

export function SettingsTransferCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const categories: readonly SettingsTransferCategory[] = SETTINGS_TRANSFER_CATEGORIES;

  return (
    <>
      <SectionCard id="st-card-settings-transfer" title={t('st.settingsTransfer.title')} scope="app">
        <div className="space-y-3">
          <Hint>{t('st.settingsTransfer.description')}</Hint>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-settings-transfer-open
            onClick={() => { setOpen(true); }}
          >
            {t('st.settingsTransfer.open')}
          </button>
        </div>
      </SectionCard>
      {open ? (
        <SettingsTransferPanel
          categories={categories}
          onClose={() => { setOpen(false); }}
        />
      ) : null}
    </>
  );
}
