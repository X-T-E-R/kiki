/**
 * Settings → 浏览器与电脑. Two tabs; this file draws the tab strip and the
 * browser tab, in the order a person decides:
 *
 *   1  may the Agent use a browser at all (the master switch and its default)
 *   2  which browsers it may use, and which one it picks first
 *   3  where those browsers come from — the sources Kiki can prepare, check
 *      and switch off one by one
 *
 * Allowed and default are separate facts and are said separately: a default
 * that is not allowed is called out, never treated as allowed.
 */

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import {
  BROWSER_CONTROL_SETTINGS_DEFAULT_TAB,
  BROWSER_CONTROL_SETTINGS_TABS,
  browserControlTabLabelKey,
  isBrowserControlEnabled,
  normalizeBrowserControlTab,
  type BrowserControlSettingsTab,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { browserKeys } from '../../lib/browserRest';
import { FeedbackLine, Hint, SaveStatus } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { DefaultOnSwitch, optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { ComputerControlSection } from './ComputerControlSection';
import { SectionCard } from './SectionCard';
import { SettingsSelect } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';
import { BrowserConnectionCard } from './browserControl/BrowserConnectionCard';
import { BrowserSetupWizard } from './browserControl/BrowserSetupWizard';
import { BrowserToolPolicy } from './browserControl/BrowserToolPolicy';
import { useBrowserAllowance } from './browserControl/browserAllowance';

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
    <div className="space-y-6">
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
          <BrowserMasterCard />
          <SectionCard id="st-card-browser-connections" title={t('st.browser.connectionsTitle')}>
            <BrowserConnectionCard summary={<BrowserSummary />} />
          </SectionCard>
          <SectionCard id="st-card-browser-setup" title={t('st.browser.setup.title')}>
            <BrowserSetupWizard />
          </SectionCard>
        </div>
      )}
    </div>
  );
}

/** May the Agent drive a browser at all: the switch, its default, and the tool policy. */
function BrowserMasterCard() {
  const { client, scopeId } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const defaultSave = useInstantSave();
  const allowance = useBrowserAllowance();

  const configQuery = useQuery({
    queryKey: ['config', scopeId],
    queryFn: () => client.getConfig(),
    staleTime: 30_000,
  });

  const browserCapability = optionalCapabilityState(configQuery.data, 'browser');
  const isEnabled = browserCapability?.allowed ?? isBrowserControlEnabled(configQuery.data);
  const browserHostLocked = browserCapability?.host_locked === true;
  const locked = save.saving || configQuery.isLoading || browserHostLocked;

  const handleToggle = (next: boolean) => {
    void save.run(async () => {
      await client.setBrowserControlEnabled(next ? null : false);
      await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
      await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
      await queryClient.invalidateQueries({ queryKey: browserKeys.presets(scopeId) });
    });
  };

  return (
    <SectionCard id="st-card-browser-enabled" title={t('st.browser.title')}>
      <div className="space-y-3" data-browser-control-enabled>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="browser-master-switch" className="cursor-pointer text-[13px] font-medium text-ink">
              {t('st.browser.enabledLabel')}
            </label>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">
              {t('st.browser.enabledHint')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SaveStatus saving={save.saving} saved={save.saved} />
            <button
              type="button"
              id="browser-master-switch"
              role="switch"
              aria-checked={isEnabled}
              data-browser-enabled-switch
              disabled={locked}
              onClick={() => { handleToggle(!isEnabled); }}
              className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors duration-[var(--kiki-motion-quick)] ${
                isEnabled ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
              } ${locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
                  isEnabled ? 'translate-x-[16px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
                }`}
              />
            </button>
          </div>
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

        {allowance.toolPolicyDenied ? (
          <p className="text-[12px] text-danger" data-browser-toolpolicy-denied>
            {t('st.browser.toolPolicyDenied')}
          </p>
        ) : allowance.toolPolicyPartial ? (
          <p className="text-[12px] text-amber-ink" data-browser-toolpolicy-partial>
            {t('st.browser.toolPolicyPartial')}
          </p>
        ) : null}
        <BrowserToolPolicy enabled={isEnabled} />
        <FeedbackLine feedback={save.error ?? defaultSave.error} />
      </div>
    </SectionCard>
  );
}

/**
 * How many browsers the Agent may use right now, and which one it lands on by
 * default. The default select lists the switched-on connections (plus the
 * current default, whatever its state); picking one never allows it.
 */
function BrowserSummary() {
  const { t } = useI18n();
  const allowance = useBrowserAllowance();
  const defaultSave = useInstantSave();
  const { connections, defaultBrowser, connectionsQuery } = allowance;

  const choices = useMemo(() => [
    { value: '', label: t('st.browser.defaultNone'), hint: t('st.browser.defaultNoneHint') },
    ...connections
      .filter((connection) => connection.enabled || connection.id === defaultBrowser)
      .map((connection) => ({
        value: connection.id,
        label: connection.name,
        hint: connection.enabled ? connection.id : `${connection.id} · ${t('st.browser.state.disabled')}`,
      })),
  ], [connections, defaultBrowser, t]);

  const defaultRow = connections.find((connection) => connection.id === defaultBrowser);
  const defaultBlocked = defaultRow !== undefined && !allowance.isEffective(defaultRow);

  const setDefault = (next: string) => {
    void defaultSave.run(() => allowance.writeDefault(next, next === ''));
  };

  return (
    <div className="space-y-1.5" id="st-card-browser-default">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink-soft">
        <span className="text-[13px] text-ink" data-browser-allowed-total>
          {t('st.browser.allowedTotal', { count: allowance.effectiveCount })}
        </span>
        {connectionsQuery.isError ? null : connections.length === 0 ? (
          <Hint>{t('st.browser.defaultEmpty')}</Hint>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <span id="browser-default-label">{t('st.browser.defaultLabel')}</span>
            <SettingsSelect
              id="browser-default"
              ariaLabel={t('st.browser.defaultLabel')}
              dataAttr="data-browser-default"
              value={defaultBrowser}
              choices={choices}
              disabled={defaultSave.saving || connectionsQuery.isLoading}
              onChange={setDefault}
              variant="row"
            />
            <SaveStatus saving={defaultSave.saving} saved={defaultSave.saved} />
          </span>
        )}
      </div>
      {defaultBlocked ? (
        <p className="text-[12px] text-amber-ink" data-browser-default-not-allowed>
          {t('st.browser.defaultNotAllowed', { name: defaultRow.name })}
        </p>
      ) : null}
      <FeedbackLine feedback={defaultSave.error} />
    </div>
  );
}
