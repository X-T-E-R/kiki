/**
 * Settings → 浏览器与电脑. Two tabs; this file draws the tab strip and the
 * browser tab, in the order a person decides:
 *
 *   1  the verdict: may the Agent reach a browser at all, and the first gate to
 *      fix when it may not — with the master switch and its new-session default
 *   2  the browsers themselves: one list, the default, and the way to add one
 *      (the sources Kiki can prepare are part of adding, and stay manageable in
 *      a fold under the list)
 *
 * Allowed and default are separate facts and are said separately: a default
 * that is not allowed is called out, never treated as allowed. Allowed is a
 * configuration fact — it is not "connected" and not "a call succeeded".
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import {
  BROWSER_CONTROL_SETTINGS_DEFAULT_TAB,
  BROWSER_CONTROL_SETTINGS_TABS,
  browserControlTabLabelKey,
  browserControlVerdict,
  isBrowserControlEnabled,
  normalizeBrowserControlTab,
  type BrowserControlSettingsTab,
  type BrowserControlVerdict,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { browserKeys } from '../../lib/browserRest';
import { FeedbackLine } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { DefaultOnSwitch, optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { ComputerControlSection } from './ComputerControlSection';
import { SectionCard } from './SectionCard';
import { useInstantSave } from './useInstantSave';
import { BrowserConnectionCard } from './browserControl/BrowserConnectionCard';
import { BrowserToolPolicy } from './browserControl/BrowserToolPolicy';
import { CapabilitySwitch, ControlVerdictLine } from './browserControl/ControlVerdict';
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
          <BrowserStatusCard />
          <SectionCard id="st-card-browser-connections" title={t('st.browser.connectionsTitle')}>
            <BrowserConnectionCard />
          </SectionCard>
        </div>
      )}
    </div>
  );
}

function verdictText(t: ReturnType<typeof useI18n>['t'], verdict: BrowserControlVerdict, defaultName: string | undefined): { text: string; detail?: string } {
  switch (verdict.kind) {
    case 'unresolved': return { text: t('st.browser.verdict.unresolved') };
    case 'host_locked': return { text: t('st.browser.verdict.hostLocked') };
    case 'off': return { text: t('st.browser.verdict.off') };
    case 'tool_denied': return { text: t('st.browser.toolPolicyDenied') };
    case 'unknown': return { text: t('st.browser.verdict.unknown') };
    case 'no_connections': return { text: t('st.browser.verdict.noConnections') };
    case 'none_allowed': return { text: t('st.browser.verdict.noneAllowed') };
    case 'default_not_allowed': return { text: t('st.browser.defaultNotAllowed', { name: defaultName ?? verdict.defaultBrowser ?? '' }) };
    case 'allowed': return {
      text: t('st.browser.verdict.allowed', { count: verdict.allowedCount }),
      detail: defaultName === undefined ? t('st.browser.verdict.noDefault') : t('st.browser.verdict.default', { name: defaultName }),
    };
  }
}

/** May the Agent drive a browser at all: the verdict, the switch, its default, the session's tool choice. */
function BrowserStatusCard() {
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

  const { connectionsQuery } = allowance;
  const verdict = browserControlVerdict({
    enabled: isEnabled,
    hostLocked: browserHostLocked,
    unresolved: browserCapability?.unresolved,
    toolPolicyDenied: allowance.toolPolicyDenied,
    connections: connectionsQuery.isSuccess ? allowance.connections : undefined,
    allowedBrowsersConfigured: allowance.allowedConfigured,
    allowedBrowsers: allowance.allowedBrowsers,
    disabledSources: allowance.disabledSources,
    defaultBrowser: allowance.defaultBrowser,
  });
  const defaultName = verdict.defaultBrowser === undefined
    ? undefined
    : allowance.connections.find((connection) => connection.id === verdict.defaultBrowser)?.name ?? verdict.defaultBrowser;
  const loading = configQuery.isPending || (connectionsQuery.isPending && isEnabled);
  const { text, detail } = loading ? { text: t('st.browser.loading'), detail: undefined } : verdictText(t, verdict, defaultName);

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
      <div className="space-y-3" data-browser-control-enabled={isEnabled ? 'true' : 'false'}>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <ControlVerdictLine
            attr="data-browser-verdict"
            kind={loading ? 'loading' : verdict.kind}
            tone={loading ? 'unknown' : verdict.tone}
            text={text}
            detail={detail}
          />
          <CapabilitySwitch
            id="browser-master-switch"
            attr="data-browser-enabled-switch"
            label={t('st.browser.enabledLabel')}
            checked={isEnabled}
            disabled={locked}
            saving={save.saving}
            saved={save.saved}
            onChange={handleToggle}
          />
        </div>
        {allowance.toolPolicyPartial && verdict.kind === 'allowed' ? (
          <p className="text-[12px] text-amber-ink" data-browser-toolpolicy-partial>{t('st.browser.toolPolicyPartial')}</p>
        ) : null}
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
        <BrowserToolPolicy enabled={isEnabled} />
        <FeedbackLine feedback={save.error ?? defaultSave.error} />
      </div>
    </SectionCard>
  );
}
