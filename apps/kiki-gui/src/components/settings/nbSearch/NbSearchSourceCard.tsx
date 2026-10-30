/**
 * 配置来源: where this server's search configuration comes from and which
 * layers win. Diagnostics for the person debugging an inherited nb-search
 * setup — it lives on the advanced tab, never on the overview.
 */

import type { NbSearchCapabilities } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { SectionCard } from '../SectionCard';
import { AdvancedDetails, SettingField } from '../fields';
import { Hint, Toggle } from '../../controls';
import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { NbSearchIssues } from './NbSearchIssues';

const LOCAL_CONFIG_BADGE: Record<string, string> = {
  present: 'border-success/40 bg-success/10 text-success',
  missing: 'border-amber-rule/60 bg-amber-card text-amber-ink',
  ignored: 'border-hairline bg-paper text-ink-faint',
  unreadable: 'border-danger/40 bg-danger/5 text-danger',
  invalid: 'border-danger/40 bg-danger/5 text-danger',
  rejected: 'border-danger/40 bg-danger/5 text-danger',
  unknown: 'border-hairline bg-paper text-ink-faint',
};

const CREDENTIALS_STATUS_LABEL: Readonly<Record<string, I18nKey>> = {
  present: 'st.nbSearch.source.credentialsPresent',
  missing: 'st.nbSearch.source.credentialsMissing',
  ignored: 'st.nbSearch.source.credentialsIgnored',
  unreadable: 'st.nbSearch.source.credentialsUnreadable',
  invalid: 'st.nbSearch.source.credentialsInvalid',
  rejected: 'st.nbSearch.source.credentialsRejected',
  unknown: 'st.nbSearch.source.credentialsUnknown',
};

export function NbSearchSourceCard({
  capabilities,
  reuseLocalConfig,
  savedReuseLocalConfig,
  onToggleReuseLocal,
  saving = false,
}: {
  capabilities: NbSearchCapabilities;
  reuseLocalConfig: boolean;
  /** The value last loaded from / saved to the server — the dirty baseline. */
  savedReuseLocalConfig: boolean;
  onToggleReuseLocal: (reuse: boolean) => void;
  saving?: boolean;
}) {
  const { t } = useI18n();
  const configSource = capabilities.config_source;
  const localConfigStatus = configSource?.local_config ?? 'unknown';
  const localConfigStatusLabelKey =
    localConfigStatus === 'present'
      ? 'st.nbSearch.source.localPresent'
      : localConfigStatus === 'missing'
        ? 'st.nbSearch.source.localMissing'
        : localConfigStatus === 'unreadable'
          ? 'st.nbSearch.source.localUnreadable'
          : localConfigStatus === 'invalid'
            ? 'st.nbSearch.source.localInvalid'
            : localConfigStatus === 'ignored'
              ? 'st.nbSearch.source.localIgnored'
              : 'st.nbSearch.source.localUnknown';

  const isDraftChanged = reuseLocalConfig !== savedReuseLocalConfig;
  const activeLayers = configSource?.layers;
  const localCredentialsStatus = configSource?.local_credentials ?? 'unknown';
  const localCredentialsLabelKey =
    CREDENTIALS_STATUS_LABEL[localCredentialsStatus] ?? 'st.nbSearch.source.credentialsUnknown';
  const credentialSourceLabelKey =
    configSource?.credential_source === 'environment+local+managed'
      ? 'st.nbSearch.source.credentialEnvironmentLocalManaged'
      : configSource?.credential_source === 'environment+managed'
        ? 'st.nbSearch.source.credentialEnvironmentManaged'
        : configSource?.credential_source === 'environment+local'
          ? 'st.nbSearch.source.credentialEnvironmentLocal'
          : configSource?.credential_source === 'environment'
            ? 'st.nbSearch.source.credentialEnvironment'
            : undefined;

  return (
    <SectionCard id="st-card-search-source" title={t('st.nbSearch.source.title')}>
      <div className="space-y-3">
        <Hint>{t('st.nbSearch.source.hint')}</Hint>

        <SettingField label={t('st.nbSearch.source.reuseLocalLabel')} htmlFor="nb-search-reuse-local" help={t('st.nbSearch.source.reuseLocalDesc')}>
          <Toggle
            id="nb-search-reuse-local"
            layout="bare"
            label={t('st.nbSearch.source.reuseLocalLabel')}
            checked={reuseLocalConfig}
            disabled={saving}
            onChange={onToggleReuseLocal}
          />
        </SettingField>

        {isDraftChanged ? (
          <p role="status" className="text-[12px] text-amber-ink">
            {t('st.nbSearch.source.draftHint')}
          </p>
        ) : null}

        {reuseLocalConfig ? (
          <Hint>{t('st.nbSearch.source.credentialsHint')}</Hint>
        ) : null}

        <div className="space-y-1.5 pt-1 text-[11px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-soft">{t('st.nbSearch.source.localConfigStatus')}</span>
            <span
              className={`inline-block rounded px-1.5 py-px text-[11px] font-medium border ${
                LOCAL_CONFIG_BADGE[localConfigStatus] ?? 'border-hairline bg-paper text-ink-faint'
              }`}
            >
              {t(localConfigStatusLabelKey)}
            </span>
          </div>
          {configSource !== undefined ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-soft">{t('st.nbSearch.source.credentialsStatus')}</span>
              <span
                className={`inline-block rounded px-1.5 py-px text-[11px] font-medium border ${
                  LOCAL_CONFIG_BADGE[localCredentialsStatus] ?? 'border-hairline bg-paper text-ink-faint'
                }`}
              >
                {t(localCredentialsLabelKey)}
              </span>
              {credentialSourceLabelKey !== undefined ? (
                <span className="text-ink-faint">· {t(credentialSourceLabelKey)}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <AdvancedDetails summary={t('st.nbSearch.source.technicalDetails')} data-technical-details>
          <div className="space-y-3">
            <div>
              <span className="font-medium text-ink-soft">{t('st.nbSearch.source.daemonHost')}:</span>{' '}
              <span className="font-mono text-ink">{t('st.nbSearch.source.daemonHostLocal')}</span>
            </div>

            {activeLayers !== undefined ? (
              <div className="pt-1">
                <span className="block font-medium text-ink-soft mb-1.5">
                  {t('st.nbSearch.source.activeLayers')}
                </span>
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                  {activeLayers.map((layer, index) => {
                    const labelKey =
                      layer === 'defaults'
                        ? 'st.nbSearch.source.layerDefaults'
                        : layer === 'local'
                          ? 'st.nbSearch.source.layerLocal'
                          : layer === 'environment'
                            ? 'st.nbSearch.source.layerEnvironment'
                            : 'st.nbSearch.source.layerKiki';
                    return (
                      <div key={layer} className="flex items-center gap-1.5">
                        {index > 0 ? <Icon name="arrowRight" size={12} className="text-ink-faint" /> : null}
                        <span className="rounded bg-paper border border-hairline px-2 py-1 text-ink">
                          {index + 1}. {t(labelKey)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {configSource !== undefined && configSource.issues.length > 0 ? (
              <div>
                <NbSearchIssues issues={configSource.issues} />
              </div>
            ) : null}
          </div>
        </AdvancedDetails>
      </div>
    </SectionCard>
  );
}
