/**
 * Settings → 浏览器. One page, two stacked sections (this one, then 电脑
 * below it); the tab strip that used to split them is gone — `?tab=browser`
 * now only scrolls this section into view, so old links keep landing here.
 *
 * The section leads with the capability header: the name, one sentence about
 * what the Agent can reach right now, the master 启用 switch, and the
 * new-session default under it. Under the header: the browser list — one row
 * per connection whose body opens its editor inline without leaving the list,
 * with an explicit 允许 switch and a ⋯ menu (设为默认 / 检查 / 连接或断开 /
 * 删除) — then the single 添加浏览器 entry, and one 高级 fold for the session
 * tool policy and the source management the old list header carried.
 */

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import {
  browserControlVerdict,
  isBrowserControlEnabled,
  type BrowserControlVerdict,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { browserKeys } from '../../lib/browserRest';
import { FeedbackLine } from '../controls';
import { optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { ComputerControlSection } from './ComputerControlSection';
import { CapabilityHeader } from './CapabilityHeader';
import { SectionCard } from './SectionCard';
import { useInstantSave } from './useInstantSave';
import { BrowserConnectionCard } from './browserControl/BrowserConnectionCard';
import { BrowserToolPolicy } from './browserControl/BrowserToolPolicy';
import { useBrowserAllowance } from './browserControl/browserAllowance';
import { AdvancedDetails } from './fields';

export function BrowserControlSection() {
  const { hash } = useLocation();
  const rawTab = new URLSearchParams(useLocation().search).get('tab');

  // `?tab=browser` (and a `#st-card-browser-*` hash) is an address for this
  // section, not a view to swap: the page renders both sections, and the tab
  // only says where the scroll lands. The computer tab is handled the same
  // way inside ComputerControlSection.
  useEffect(() => {
    if (rawTab !== 'browser') return;
    const target = hash !== '' ? document.querySelector(hash) : document.querySelector('[data-settings-browser-control]');
    target?.scrollIntoView({ block: 'start' });
  }, [rawTab, hash]);

  return (
    <div className="space-y-6" data-settings-browser-control>
      <BrowserSection />
      <ComputerControlSection />
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

function BrowserSection() {
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
    <>
      <SectionCard id="st-card-browser-enabled" title={t('st.browser.title')}>
        <CapabilityHeader
          title={t('st.browser.title')}
          verdict={{ kind: loading ? 'loading' : verdict.kind, tone: loading ? 'unknown' : verdict.tone, text, detail }}
          enabled={isEnabled}
          onEnabledChange={handleToggle}
          enabledLockedReason={browserHostLocked ? t('st.browser.verdict.hostLocked') : undefined}
          saving={save.saving}
          saved={save.saved}
          defaultOn={browserCapability === undefined ? undefined : {
            checked: browserCapability.default_on,
            locked: browserCapability.unresolved || browserCapability.host_locked,
          }}
          onDefaultOnChange={(next) => {
            void defaultSave.run(async () => {
              await client.patchConfig({ optional_capabilities: { defaults: { browser: next } } });
              await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
            });
          }}
          defaultOnSaving={defaultSave.saving}
          attrs={{
            enabled: 'data-browser-control-enabled',
            verdict: 'data-browser-verdict',
            enabledSwitch: 'data-browser-enabled-switch',
            defaultOn: 'data-capability-default-browser',
          }}
        >
          {allowance.toolPolicyPartial && verdict.kind === 'allowed' ? (
            <p className="text-[12px] text-amber-ink" data-browser-toolpolicy-partial>{t('st.browser.toolPolicyPartial')}</p>
          ) : null}
          <FeedbackLine feedback={save.error ?? defaultSave.error} />
        </CapabilityHeader>
      </SectionCard>

      <SectionCard id="st-card-browser-connections" title={t('st.browser.connectionsTitle')}>
        <BrowserConnectionCard />
        <AdvancedDetails summary={t('st.browser.advanced')} data-browser-advanced-fold>
          <div className="space-y-4 pt-1">
            <BrowserToolPolicy enabled={isEnabled} />
          </div>
        </AdvancedDetails>
      </SectionCard>
    </>
  );
}
