import {
  REQUEST_IDENTITY_CHOICES,
  requestIdentityChoiceProfile,
  requestIdentityProfileChoice,
  type RequestIdentityChoice,
  type RequestIdentityLayerDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { Hint } from './controls';
import { INPUT, SECONDARY_BUTTON } from './ui';
import { SettingsSelect } from './settings/SettingsPrimitives';

function missingProfileChoice(
  choice: RequestIdentityChoice,
  profiles: readonly { readonly id: string }[],
  t: ReturnType<typeof useI18n>['t'],
): { value: RequestIdentityChoice; label: string }[] {
  const id = requestIdentityChoiceProfile(choice);
  if (id === undefined || profiles.some((profile) => profile.id === id)) return [];
  return [{ value: choice, label: t('st.requestIdentity.option.custom', { label: id }) }];
}

export function RequestIdentityLayerEditor({
  value,
  onChange,
  label,
  inheritLabel,
  hint,
  issue = null,
  customProfiles = [],
  overridesOnly = false,
}: {
  value: RequestIdentityLayerDraft;
  onChange: (value: RequestIdentityLayerDraft) => void;
  label: string;
  inheritLabel: string;
  hint: string;
  /** Why the last save was refused (bad JSON, empty custom layer); shown under the textarea. */
  issue?: string | null;
  /** Custom identities from Settings → Request identity, offered after the built-ins. */
  customProfiles?: readonly { readonly id: string; readonly label: string }[];
  /**
   * Renders only the override body and its clear action, for a surface that
   * already shows the identity choice above. The layer, the options and the
   * meaning of the JSON are unchanged: this hides a selector the caller has
   * already drawn, nothing more.
   *
   * An inherited layer keeps its body reachable here. There is a body to write
   * exactly once, so an "Advanced" disclosure that opens onto nothing is not a
   * disclosure. Typing moves the layer to the override-only state, which is the
   * contract that layer already has; an untouched body leaves the layer
   * inherited, so this layer contributes nothing and whatever identity is
   * configured above still applies. Once authored, clearing the body is the
   * deliberate way back to inherited — emptying the text alone leaves an
   * override-only layer that its own schema will refuse to save.
   */
  overridesOnly?: boolean;
}) {
  const { t } = useI18n();
  const inherited = value.requestIdentityChoice === 'inherit';
  const authored = !inherited || overridesOnly;

  const choose = (choice: RequestIdentityChoice) => {
    onChange({
      requestIdentityChoice: choice,
      requestIdentityOverridesJson:
        choice === 'inherit' ? '' : value.requestIdentityOverridesJson,
    });
  };

  /**
   * Writing the body on an inherited layer is what makes it authored. An
   * already-authored layer keeps its own choice, so emptying a `custom_overrides`
   * body still owes the non-empty object its schema asks for instead of quietly
   * falling back to inherited and hiding the problem.
   */
  const writeOverrides = (json: string) => {
    const next = inherited
      ? (json.trim() === '' ? 'inherit' : 'custom_overrides')
      : value.requestIdentityChoice;
    onChange({ requestIdentityChoice: next, requestIdentityOverridesJson: json });
  };

  return (
    <div className="space-y-3">
      {overridesOnly ? null : (
      <div>
        <div className="space-y-1 text-[11px] font-medium text-ink-soft">
          <span className="block">{label}</span>
          <SettingsSelect<RequestIdentityChoice>
            variant="form"
            dataAttr="data-request-identity-choice"
            ariaLabel={label}
            value={value.requestIdentityChoice}
            onChange={choose}
            choices={[
              ...REQUEST_IDENTITY_CHOICES.map((choice) => ({
                value: choice,
                label: choice === 'inherit' ? inheritLabel : t(`st.requestIdentity.option.${choice as Exclude<RequestIdentityChoice, `profile:${string}` | 'inherit'>}`),
              })),
              ...customProfiles.map((profile) => ({
                value: requestIdentityProfileChoice(profile.id),
                label: t('st.requestIdentity.option.custom', { label: profile.label }),
              })),
              ...missingProfileChoice(value.requestIdentityChoice, customProfiles, t),
            ]}
          />
        </div>
        <Hint>{hint}</Hint>
      </div>
      )}
      {authored ? (
        <div>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.requestIdentity.overrides')}
            <textarea
              className={`${INPUT} mt-1 min-h-24 font-mono ${issue !== null ? 'border-danger' : ''}`}
              aria-invalid={issue !== null}
              data-request-identity-overrides
              spellCheck={false}
              value={value.requestIdentityOverridesJson}
              onChange={(event) => { writeOverrides(event.target.value); }}
              placeholder={t('st.requestIdentity.overridesPlaceholder')}
            />
          </label>
          {issue !== null ? <p role="alert" className="mt-1 text-[12px] text-danger">{issue}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-start justify-between gap-2">
            <Hint>{t(inherited
              ? 'st.requestIdentity.overridesStartHint'
              : value.requestIdentityChoice === 'custom_overrides'
                ? 'st.requestIdentity.overridesRequiredHint'
                : 'st.requestIdentity.overridesOptionalHint')}</Hint>
            {/* Nothing to clear while the layer is still inherited: the body is
                empty by definition, so the action would have nothing to do. */}
            {inherited ? null : (
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { choose('inherit'); }}>
                {t('st.requestIdentity.clearLayer')}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
