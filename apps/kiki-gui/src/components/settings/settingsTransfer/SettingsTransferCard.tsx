import { useNavigate } from 'react-router-dom';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';
import { SettingField, SettingsBox } from '../fields';

export function SettingsTransferCard() {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <SectionCard id="st-card-settings-transfer" title={t('st.settingsTransfer.title')} scope="app">
      <SettingsBox>
        <SettingField label={t('st.portable.title')} help={t('st.settingsTransfer.description')}>
          <button
            type="button"
            className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
            data-settings-transfer-open
            onClick={() => { void navigate('/settings/subscriptions#st-card-portable-spaces'); }}
          >
            <span>{t('st.settingsTransfer.openSpaces')}</span>
            <Icon name="arrowRight" size={12} />
          </button>
        </SettingField>
      </SettingsBox>
    </SectionCard>
  );
}
