import {
  REQUEST_IDENTITY_CHOICES,
  type RequestIdentityChoice,
  type RequestIdentityLayerDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { Hint } from './controls';
import { INPUT, SECONDARY_BUTTON } from './ui';

export function RequestIdentityLayerEditor({
  value,
  onChange,
  label,
  inheritLabel,
  hint,
}: {
  value: RequestIdentityLayerDraft;
  onChange: (value: RequestIdentityLayerDraft) => void;
  label: string;
  inheritLabel: string;
  hint: string;
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
        <label className="block text-[11px] font-medium text-ink-soft">{label}
          <select
            className={`${INPUT} mt-1`}
            value={value.requestIdentityChoice}
            onChange={(event) => { choose(event.target.value as RequestIdentityChoice); }}
          >
            {REQUEST_IDENTITY_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice === 'inherit' ? inheritLabel : t(`st.requestIdentity.option.${choice}`)}
              </option>
            ))}
          </select>
        </label>
        <Hint>{hint}</Hint>
      </div>
      {authored ? (
        <div>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.requestIdentity.overrides')}
            <textarea
              className={`${INPUT} mt-1 min-h-24 font-mono`}
              value={value.requestIdentityOverridesJson}
              onChange={(event) => {
                onChange({ ...value, requestIdentityOverridesJson: event.target.value });
              }}
              placeholder={t('st.requestIdentity.overridesPlaceholder')}
            />
          </label>
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
