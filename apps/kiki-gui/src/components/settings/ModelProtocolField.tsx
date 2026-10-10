/**
 * The per-model request format picker.
 *
 * It sits next to the model's ID because the two answer the same question:
 * "what exactly gets sent for this model". It is deliberately not grouped
 * with request identity, which decides who the request claims to come from,
 * not how its body is shaped.
 *
 * "Provider default" is a real choice, not an empty one: it saves as `null`
 * and clears an override. When the server has resolved the inherited format
 * the option says which one, so following the provider is never a guess.
 */

import type { ModelProtocol } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { Hint } from '../controls';
import { FORM_LABEL, SettingsSelect } from './SettingsPrimitives';
import { MODEL_PROTOCOLS, MODEL_PROTOCOL_LABEL, type ModelProtocolChoice } from './modelProtocolDraft';

export function ModelProtocolField({ model, value, resolved, onChange, disabled = false, showHint = true }: {
  /** Alias or remote id, only for the accessible name. */
  model: string;
  value: ModelProtocolChoice;
  /**
   * What the provider currently resolves to. Pass it only while the stored
   * value inherits; once this model names its own format the server's
   * resolved value describes the override, not the provider.
   */
  resolved?: ModelProtocol;
  onChange: (next: ModelProtocolChoice) => void;
  disabled?: boolean;
  showHint?: boolean;
}) {
  const { t } = useI18n();
  const inheritLabel = resolved === undefined
    ? t('st.modelProtocol.inherit')
    : t('st.modelProtocol.inheritResolved', { format: t(MODEL_PROTOCOL_LABEL[resolved]) });
  const choices: { value: ModelProtocolChoice; label: string; hint?: string }[] = [
    { value: 'inherit', label: inheritLabel },
    ...MODEL_PROTOCOLS.map((protocol) => ({ value: protocol, label: t(MODEL_PROTOCOL_LABEL[protocol]), hint: protocol })),
  ];
  return (
    <div className="min-w-0 space-y-1" data-model-protocol-field={value}>
      <p className={FORM_LABEL}>{t('st.modelProtocol.label')}</p>
      <SettingsSelect<ModelProtocolChoice>
        variant="form"
        choices={choices}
        value={value}
        onChange={onChange}
        ariaLabel={t('st.modelProtocol.aria', { model })}
        disabled={disabled}
        dataAttr="data-model-protocol"
      />
      {showHint ? <Hint>{t('st.modelProtocol.hint')}</Hint> : null}
    </div>
  );
}
