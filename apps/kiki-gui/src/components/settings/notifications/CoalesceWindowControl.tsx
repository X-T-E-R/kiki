import { useI18n } from '../../../i18n';
import { SettingsSegmented, type SettingsChoice } from '../SettingsPrimitives';

/** Preset coalescing windows for the account policy and individual bindings. */
export function CoalesceWindowControl({ ariaLabel, value, onChange, disabled = false, allowDefault = true, dataAttr }: {
  ariaLabel: string;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  allowDefault?: boolean;
  dataAttr?: string;
}) {
  const { t } = useI18n();
  const choices: SettingsChoice<string>[] = [
    ...(allowDefault ? [{ value: 'default', label: t('st.im.coalesce.followDefault') }] : []),
    { value: '0', label: t('st.im.coalesce.off') },
    { value: '2000', label: t('st.im.coalesce.2s') },
    { value: '3000', label: t('st.im.coalesce.3s') },
    { value: '5000', label: t('st.im.coalesce.5s') },
  ];
  const selected = value === null || value === undefined
    ? allowDefault ? 'default' : '0'
    : String(value);

  return <SettingsSegmented ariaLabel={ariaLabel} value={selected} disabled={disabled} dataAttr={dataAttr}
    choices={choices} onChange={(next) => { onChange(next === 'default' ? null : Number(next)); }} />;
}
