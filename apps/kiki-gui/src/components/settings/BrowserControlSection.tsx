import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import {
  BROWSER_CONTROL_SETTINGS_DEFAULT_TAB,
  BROWSER_CONTROL_SETTINGS_TABS,
  browserControlTabLabelKey,
  effectiveAllowedBrowserCount,
  isBrowserControlEnabled,
  isBrowserToolPolicyDenied,
  isBrowserToolPolicyPartiallyDenied,
  normalizeBrowserControlTab,
  type BrowserControlSettingsTab,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { browserApi, browserKeys } from '../../lib/browserRest';
import { FeedbackLine, Hint, SaveStatus } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { DefaultOnSwitch, optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { ComputerControlSection } from './ComputerControlSection';
import { SectionCard } from './SectionCard';
import { AdvancedDetails } from './fields';
import { SettingsSelect } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';
import { BrowserConnectionCard } from './browserControl/BrowserConnectionCard';
import { BrowserSetupWizard } from './browserControl/BrowserSetupWizard';
import { WebBridgeReadiness } from './browserControl/WebBridgeReadiness';
import { BrowserToolPolicy } from './browserControl/BrowserToolPolicy';

export function BrowserControlSection() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { search } = useLocation();
  const rawTab = new URLSearchParams(search).get('tab');
  const tab: BrowserControlSettingsTab = normalizeBrowserControlTab(rawTab) ?? BROWSER_CONTROL_SETTINGS_DEFAULT_TAB;

  const selectTab = (next: BrowserControlSettingsTab) => {
    if (next === tab) return;
    const params = new URLSearchParams(search);
    params.set('tab', next);
    void navigate(`/settings/browser-control?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={t('st.section.browserControl')} className="flex flex-wrap gap-1 border-b border-hairline">
        {BROWSER_CONTROL_SETTINGS_TABS.map((candidate) => {
          const active = candidate === tab;
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={active}
              data-browser-control-tab={candidate}
              onClick={() => { selectTab(candidate); }}
              className={`-mb-px min-h-9 border-b-2 px-3 py-1.5 text-[13px] transition-colors ${
                active
                  ? 'border-ink font-medium text-ink'
                  : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {t(browserControlTabLabelKey(candidate))}
            </button>
          );
        })}
      </div>
      {tab === 'computer' ? (
        <ComputerControlSection />
      ) : (
        <div className="space-y-6" data-settings-browser-control>
          <div className="sticky top-0 z-10 -mx-1 bg-paper/95 px-1 py-1 backdrop-blur-[2px]" data-browser-status-bar>
            <BrowserMasterCard />
          </div>
          <SectionCard id="st-card-browser-setup" title={t('st.browser.setup.title')}>
            <BrowserSetupWizard />
          </SectionCard>
          <WebBridgeReadiness />
          <AdvancedDetails summary={t('st.browser.advanced.title')} data-browser-advanced-region>
            <SectionCard id="st-card-browser-connections" title={t('st.browser.connectionsTitle')}>
              <BrowserConnectionCard />
            </SectionCard>
          </AdvancedDetails>
        </div>
      )}
    </div>
  );
}

function BrowserMasterCard() {
  const { client, scopeId } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const defaultSave = useInstantSave();

  const configQuery = useQuery({
    queryKey: ['config', scopeId],
    queryFn: () => client.getConfig(),
    staleTime: 30_000,
  });

  const connectionsQuery = useQuery({
    queryKey: browserKeys.connections(scopeId),
    queryFn: () => browserApi(client).list(),
    staleTime: 10_000,
  });

  const browserCapability = optionalCapabilityState(configQuery.data, 'browser');
  const isEnabled = browserCapability?.allowed ?? isBrowserControlEnabled(configQuery.data);
  const browserHostLocked = browserCapability?.host_locked === true;
  const toolPolicyDenied = isBrowserToolPolicyDenied(configQuery.data);
  const toolPolicyPartiallyDenied = isBrowserToolPolicyPartiallyDenied(configQuery.data);

  const connections = connectionsQuery.data?.connections ?? [];
  const currentDefault = connectionsQuery.data?.defaultBrowser ?? '';
  const allowedBrowsers = (connectionsQuery.data as { allowedBrowsers?: string[] } | undefined)?.allowedBrowsers
    ?? (configQuery.data as { browser_control?: { allowedBrowsers?: string[] } } | undefined)?.browser_control?.allowedBrowsers;
  const isAllowedConfigured = (connectionsQuery.data as { allowedBrowsersConfigured?: boolean } | undefined)?.allowedBrowsersConfigured === true
    || (configQuery.data as { browser_control?: { allowedBrowsersConfigured?: boolean } } | undefined)?.browser_control?.allowedBrowsersConfigured === true;

  const allowedCount = effectiveAllowedBrowserCount(connections, isAllowedConfigured, allowedBrowsers);

  const choices = useMemo(() => [
    { value: '', label: t('st.browser.defaultNone'), hint: t('st.browser.defaultNoneHint') },
    ...connections
      .filter((connection) => connection.enabled || connection.id === currentDefault)
      .map((connection) => ({
        value: connection.id,
        label: connection.name,
        hint: connection.enabled ? connection.id : `${connection.id} · ${t('st.browser.state.disabled')}`,
      })),
  ], [connections, currentDefault, t]);

  const handleToggle = (next: boolean) => {
    void save.run(async () => {
      await client.setBrowserControlEnabled(next ? null : false);
      await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
      await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
      await queryClient.invalidateQueries({ queryKey: browserKeys.presets(scopeId) });
    });
  };

  const setDefault = (next: string) => {
    void defaultSave.run(async () => {
      await browserApi(client).setDefault(next === '' ? undefined : next);
      await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
    });
  };

  return (
    <SectionCard id="st-card-browser-enabled" title={t('st.browser.title')}>
      <div className="space-y-3" data-browser-control-enabled>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="browser-master-switch" className="text-[13px] font-medium text-ink cursor-pointer">
              {t('st.browser.enabledLabel')}
            </label>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">
              {t('st.browser.enabledHint')}
            </p>
          </div>
          <button
            type="button"
            id="browser-master-switch"
            role="switch"
            aria-checked={isEnabled}
            data-browser-enabled-switch
            disabled={save.saving || configQuery.isLoading || browserHostLocked}
            onClick={() => { handleToggle(!isEnabled); }}
            className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors duration-[var(--kiki-motion-quick)] ${
              isEnabled ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
            } ${save.saving || configQuery.isLoading || browserHostLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-3 w-3 transform rounded-full transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
                isEnabled ? 'translate-x-[16px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
              }`}
            />
          </button>
        </div>
        <DefaultOnSwitch
          id="browser"
          state={browserCapability}
          disabled={defaultSave.saving}
          onChange={(next) => {
            void defaultSave.run(async () => {
              await client.patchConfig({ optional_capabilities: { defaults: { browser: next } } });
              await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
            });
          }}
        />

        {toolPolicyDenied ? (
          <p className="text-[12px] text-danger" data-browser-toolpolicy-denied>
            {t('st.browser.toolPolicyDenied')}
          </p>
        ) : toolPolicyPartiallyDenied ? (
          <p className="text-[12px] text-amber-ink" data-browser-toolpolicy-partial>
            {t('st.browser.toolPolicyPartial')}
          </p>
        ) : null}
        <BrowserToolPolicy enabled={isEnabled} />

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-hairline text-[12px] text-ink-soft">
          <span data-browser-allowed-total>
            {t('st.browser.allowedTotal', { count: allowedCount })}
          </span>
          <div id="st-card-browser-default" className="flex flex-wrap items-center gap-2">
            {connectionsQuery.isError ? null : connections.length === 0 ? (
              <Hint>{t('st.browser.defaultEmpty')}</Hint>
            ) : (
              <>
                <span id="browser-default-label" className="text-[12px] text-ink-soft">
                  {t('st.browser.defaultLabel')}
                </span>
                <SettingsSelect
                  id="browser-default"
                  ariaLabel={t('st.browser.defaultLabel')}
                  dataAttr="data-browser-default"
                  value={currentDefault}
                  choices={choices}
                  disabled={defaultSave.saving || connectionsQuery.isLoading}
                  onChange={setDefault}
                  variant="row"
                />
                <SaveStatus saving={defaultSave.saving} saved={defaultSave.saved} />
              </>
            )}
            <SaveStatus saving={save.saving} saved={save.saved} />
          </div>
        </div>
        <FeedbackLine feedback={save.error ?? defaultSave.error} />
      </div>
    </SectionCard>
  );
}
