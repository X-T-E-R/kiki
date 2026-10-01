import { useI18n } from '../../../i18n';
import { Toggle } from '../../controls';
import { ModelMenuPreview, type ModelMenuPreviewData } from './ModelMenuPreview';

export function ModelMenuField({ checked, baselineChecked, disabled, onChange, preview, pending, error, onRetry }: {
  checked: boolean;
  baselineChecked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  preview?: ModelMenuPreviewData;
  pending?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  return <div data-profile-field="restrictModelsToMenu" className="space-y-2">
    <Toggle layout="row" label={t('st.profiles.restrictModelsToMenu')} checked={checked} disabled={disabled} onChange={onChange} />
    <p className="text-[11.5px] leading-snug text-ink-soft">{t(checked ? 'st.profiles.menuOnHint' : 'st.profiles.menuOffHint')}</p>
    {checked ? <ModelMenuPreview value={preview} pending={pending} error={error} onRetry={onRetry} /> : null}
    {!checked && baselineChecked ? <p data-menu-disabled role="status" className="text-[12px] text-amber-ink">{t('st.profiles.menuDisabled')}</p> : null}
  </div>;
}
