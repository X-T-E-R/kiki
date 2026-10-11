import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { browserApi, browserKeys } from '../../lib/browserRest';
import { FeedbackLine, Hint, SaveStatus } from '../controls';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import { SettingsSelect } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';
import { BrowserConnectionCard } from './browserControl/BrowserConnectionCard';
import { BrowserSetupWizard } from './browserControl/BrowserSetupWizard';
import { WebBridgeReadiness } from './browserControl/WebBridgeReadiness';

export function BrowserControlSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-6" data-settings-browser-control>
      <SectionCard id="st-card-browser-setup" title={t('st.browser.setup.title')}>
        <BrowserSetupWizard />
      </SectionCard>
      <DefaultBrowserCard />
      {/* The bridge's own readiness. It answers the same question as the setup
          card above — is browser control working — so it sits with it rather
          than on the Plugins leaf, where a browser fact read as a plugin. */}
      <WebBridgeReadiness />
      {/* Everything a person types rather than picks sits below the routes that
          need no typing, and stays folded: a hand-written CDP address or a
          driver path is a real way in, but it is the exception, not the
          opening move. Editing what is already saved lives in here too. */}
      <AdvancedDetails summary={t('st.browser.advanced.title')} data-browser-advanced-region>
        <SectionCard id="st-card-browser-connections" title={t('st.browser.connectionsTitle')}>
          <BrowserConnectionCard />
        </SectionCard>
      </AdvancedDetails>
    </div>
  );
}

/**
 * The default is a single value with its own write, so it saves on the spot and
 * the list is re-read afterwards — the shown value is always the server's.
 */
function DefaultBrowserCard() {
  const { client, scopeId } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const query = useQuery({
    queryKey: browserKeys.connections(scopeId),
    queryFn: () => browserApi(client).list(),
    staleTime: 10_000,
  });

  const connections = query.data?.connections ?? [];
  const current = query.data?.defaultBrowser ?? '';
  const choices = useMemo(() => [
    { value: '', label: t('st.browser.defaultNone'), hint: t('st.browser.defaultNoneHint') },
    // A connection that was switched off after being chosen is still the stored
    // default, so it stays visible as the current value instead of vanishing.
    ...connections
      .filter((connection) => connection.enabled || connection.id === current)
      .map((connection) => ({
        value: connection.id,
        label: connection.name,
        hint: connection.enabled ? connection.id : `${connection.id} · ${t('st.browser.state.disabled')}`,
      })),
  ], [connections, current, t]);

  const setDefault = (next: string) => {
    void save.run(async () => {
      await browserApi(client).setDefault(next === '' ? undefined : next);
      await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
    });
  };

  return (
    <SectionCard id="st-card-browser-default" title={t('st.browser.defaultTitle')}>
      {query.isError ? null : connections.length === 0 ? (
        <Hint>{t('st.browser.defaultEmpty')}</Hint>
      ) : (
        <>
          <SettingField label={t('st.browser.defaultLabel')} labelId="browser-default-label"
            help={t('st.browser.defaultHint')}>
            <SettingsSelect id="browser-default" ariaLabel={t('st.browser.defaultLabel')}
              dataAttr="data-browser-default" value={current} choices={choices}
              disabled={save.saving || query.isLoading}
              onChange={setDefault} />
            <SaveStatus saving={save.saving} saved={save.saved} />
          </SettingField>
          <FeedbackLine feedback={save.error} />
        </>
      )}
    </SectionCard>
  );
}
