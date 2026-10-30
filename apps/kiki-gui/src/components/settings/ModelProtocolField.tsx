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

import type { BindingOrigin, ModelProtocol, ModelProtocolSource } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { SettingHelp } from './SettingHelp';
import { FORM_LABEL, SettingsSelect } from './SettingsPrimitives';
import { MODEL_PROTOCOLS, MODEL_PROTOCOL_LABEL, type ModelProtocolChoice } from './modelProtocolDraft';

const PROTOCOL_SOURCE_LABEL = {
  model: 'st.modelProtocol.source.model',
  provider: 'st.modelProtocol.source.provider',
  vendor: 'st.modelProtocol.source.vendor',
} as const;

const ORIGIN_LABEL = {
  model: 'st.modelProtocol.origin.model',
  provider: 'st.modelProtocol.origin.provider',
  env: 'st.modelProtocol.origin.env',
  vendor: 'st.modelProtocol.origin.vendor',
  none: 'st.modelProtocol.origin.none',
} as const;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function originText(label: string, source: BindingOrigin, envName: string | undefined): string {
  if (source !== 'env' || envName === undefined || !ENV_NAME.test(envName)) return label;
  return `${label} (${envName})`;
}

export function ModelProtocolField({ model, value, resolved, source, endpointSource, authSource, endpointEnv, authEnv, onChange, disabled = false }: {
  /** Alias or remote id, only for the accessible name. */
  model: string;
  value: ModelProtocolChoice;
  /**
   * What the provider currently resolves to. Pass it only while the stored
   * value inherits; once this model names its own format the server's
   * resolved value describes the override, not the provider.
   */
  resolved?: ModelProtocol;
  /** Where `resolved` came from. Pass it only while the stored value inherits. */
  source?: ModelProtocolSource;
  /** Where the effective endpoint and credential come from. Names only; never a URL or a key. */
  endpointSource?: BindingOrigin;
  authSource?: BindingOrigin;
  endpointEnv?: string;
  authEnv?: string;
  onChange: (next: ModelProtocolChoice) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const inheritLabel = resolved === undefined
    ? t('st.modelProtocol.inherit')
    : t('st.modelProtocol.inheritResolved', { format: t(MODEL_PROTOCOL_LABEL[resolved]) });
  const choices: { value: ModelProtocolChoice; label: string; hint?: string }[] = [
    { value: 'inherit', label: inheritLabel },
    ...MODEL_PROTOCOLS.map((protocol) => ({ value: protocol, label: t(MODEL_PROTOCOL_LABEL[protocol]), hint: protocol })),
  ];
  const effectiveFormat = value === 'inherit' ? resolved : value;
  const effectiveSource = value === 'inherit' ? source : 'model';
  return (
    <div className="min-w-0 space-y-1" data-model-protocol-field={value}>
      <div className="flex items-center gap-1.5">
        <p className={FORM_LABEL}>{t('st.modelProtocol.label')}</p>
        {effectiveFormat !== undefined && effectiveSource !== undefined ? (
          // Where the format, endpoint and key come from is reference text,
          // read on demand rather than a line under the picker.
          <SettingHelp>
            <span data-effective-protocol>
              {t('st.modelProtocol.effective', {
                format: t(MODEL_PROTOCOL_LABEL[effectiveFormat]),
                source: t(PROTOCOL_SOURCE_LABEL[effectiveSource]),
              })}
              {endpointSource !== undefined || authSource !== undefined
                ? ` · ${t('st.modelProtocol.bindingOrigins', {
                  endpoint: originText(t(ORIGIN_LABEL[endpointSource ?? 'none']), endpointSource ?? 'none', endpointEnv),
                  credential: originText(t(ORIGIN_LABEL[authSource ?? 'none']), authSource ?? 'none', authEnv),
                })}`
                : ''}
            </span>
          </SettingHelp>
        ) : null}
      </div>
      <SettingsSelect<ModelProtocolChoice>
        variant="form"
        choices={choices}
        value={value}
        onChange={onChange}
        ariaLabel={t('st.modelProtocol.aria', { model })}
        disabled={disabled}
        dataAttr="data-model-protocol"
      />
    </div>
  );
}
