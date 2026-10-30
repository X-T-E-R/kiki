import { useState } from 'react';

import { SETTINGS_TRANSFER_CATEGORIES, type SettingsTransferCategory } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { SectionCard } from '../SectionCard';
import { SECONDARY_BUTTON } from '../../ui';
import { SettingField, SettingsBox } from '../fields';
import { SettingsTransferPanel } from './SettingsTransferPanel';

export function SettingsTransferCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const categories: readonly SettingsTransferCategory[] = SETTINGS_TRANSFER_CATEGORIES;

  return (
    <>
      <SectionCard id="st-card-settings-transfer" title={t('st.settingsTransfer.title')} scope="app">
        <SettingsBox>
          <SettingField label={t('st.settingsTransfer.open')} help={t('st.settingsTransfer.description')}>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              data-settings-transfer-open
              onClick={() => { setOpen(true); }}
            >
              {t('st.settingsTransfer.open')}
            </button>
          </SettingField>
        </SettingsBox>
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
