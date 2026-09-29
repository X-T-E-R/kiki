import {
  REQUEST_IDENTITY_CHOICES,
  type RequestIdentityChoice,
  type RequestIdentityLayerDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { Hint } from './controls';
import { INPUT, SECONDARY_BUTTON } from './ui';
import { SettingsSelect } from './settings/SettingsPrimitives';

export function RequestIdentityLayerEditor({
  value,
  onChange,
  label,
  inheritLabel,
  hint,
  issue = null,
}: {
  value: RequestIdentityLayerDraft;
  onChange: (value: RequestIdentityLayerDraft) => void;
  label: string;
  inheritLabel: string;
  hint: string;
  /** Why the last save was refused (bad JSON, empty custom layer); shown under the textarea. */
  issue?: string | null;
}) {
  const { t } = useI18n();
  const authored = value.requestIdentityChoice !== 'inherit';

  const choose = (choice: RequestIdentityChoice) => {
    onChange({
      requestIdentityChoice: choice,
      requestIdentityOverridesJson:
        choice === 'inherit' ? '' : value.requestIdentityOverridesJson,
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="space-y-1 text-[11px] font-medium text-ink-soft">
          <span className="block">{label}</span>
          <SettingsSelect<RequestIdentityChoice>
            variant="form"
            dataAttr="data-request-identity-choice"
            ariaLabel={label}
            value={value.requestIdentityChoice}
            onChange={choose}
            choices={REQUEST_IDENTITY_CHOICES.map((choice) => ({
              value: choice,
              label: choice === 'inherit' ? inheritLabel : t(`st.requestIdentity.option.${choice}`),
            }))}
          />
        </div>
        <Hint>{hint}</Hint>
      </div>
      {authored ? (
        <div>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.requestIdentity.overrides')}
            <textarea
              className={`${INPUT} mt-1 min-h-24 font-mono ${issue !== null ? 'border-danger' : ''}`}
              aria-invalid={issue !== null}
              spellCheck={false}
              value={value.requestIdentityOverridesJson}
              onChange={(event) => {
                onChange({ ...value, requestIdentityOverridesJson: event.target.value });
              }}
              placeholder={t('st.requestIdentity.overridesPlaceholder')}
            />
          </label>
          {issue !== null ? <p role="alert" className="mt-1 text-[12px] text-danger">{issue}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-start justify-between gap-2">
            <Hint>{t(value.requestIdentityChoice === 'custom_overrides'
              ? 'st.requestIdentity.overridesRequiredHint'
              : 'st.requestIdentity.overridesOptionalHint')}</Hint>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { choose('inherit'); }}>
              {t('st.requestIdentity.clearLayer')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
