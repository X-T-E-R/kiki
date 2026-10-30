/**
 * Settings → 浏览器与电脑. Two switchable tabs, 浏览器 | 电脑: the tab is the
 * `?tab=` query, so search hits and `#st-card-*` deep links land on the tab
 * that mounts their card (a hash with no tab selects the card's owning tab via
 * `browserControlTabForCard`). Each tab leads with its capability header: the
 * name, one sentence about what the Agent can reach right now, the master 启用
 * switch, and the new-session default under it. The browser tab then lists one
 * row per connection whose body opens its editor inline without leaving the
 * list, with an explicit 允许 switch and a ⋯ menu (设为默认 / 检查 / 连接或断开 /
 * 删除), then the single 添加浏览器 entry, and one 高级 fold for the session
 * tool policy.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BROWSER_CONTROL_SETTINGS_DEFAULT_TAB,
  BROWSER_CONTROL_SETTINGS_TABS,
  browserControlTabForCard,
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
import { optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { ComputerControlSection } from './ComputerControlSection';
import { CapabilityHeader } from './CapabilityHeader';
import { SectionCard } from './SectionCard';
import { useInstantSave } from './useInstantSave';
import { AddBrowserAction, BrowserConnectionCard } from './browserControl/BrowserConnectionCard';
import { BrowserToolPolicy } from './browserControl/BrowserToolPolicy';
import { useBrowserAllowance } from './browserControl/browserAllowance';
import { AdvancedDetails } from './fields';

export function BrowserControlSection({ initialTab }: { readonly initialTab?: BrowserControlSettingsTab } = {}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  const urlTab = normalizeBrowserControlTab(params.get('tab'));
  // Mounted state, not the bare URL: a deep link resolves to its tab once,
  // and tab clicks keep moving even under a router that swallows a navigate
  // while something else guards it.
  const [mounted, setMounted] = useState<BrowserControlSettingsTab>(initialTab ?? urlTab ?? BROWSER_CONTROL_SETTINGS_DEFAULT_TAB);
  const requested = urlTab ?? mounted;
  const tab: BrowserControlSettingsTab = mounted === requested ? mounted : requested;
  const tabsRef = useRef<HTMLDivElement>(null);

  const selectTab = (next: BrowserControlSettingsTab, focus = false) => {
    if (focus) tabsRef.current?.querySelector<HTMLButtonElement>(`[data-browser-control-tab="${next}"]`)?.focus();
    if (next === tab) return;
    setMounted(next);
    params.set('tab', next);
    void navigate(`/settings/browser-control?${params.toString()}${hash}`);
  };

  // A `#st-card-*` hash without a tab names a card, and the card names its
  // tab: select the owning tab first, so the page's card handshake finds the
  // card mounted when it scrolls. An explicit tab never gets corrected.
  useEffect(() => {
    if (urlTab !== undefined && urlTab !== mounted) setMounted(urlTab);
  }, [urlTab, mounted]);
  useEffect(() => {
    const cardId = hash.replace(/^#/, '');
    if (cardId === '' || urlTab !== undefined) return;
    const owner = browserControlTabForCard(cardId);
    if (owner === undefined || owner === tab) return;
    selectTab(owner);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, search]);

  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    const last = BROWSER_CONTROL_SETTINGS_TABS.length - 1;
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    selectTab(BROWSER_CONTROL_SETTINGS_TABS[target]!, true);
  };

  return (
    <div className="space-y-6" data-settings-browser-control>
      <div ref={tabsRef} role="tablist" aria-label={t('st.section.browserControl')} className="flex flex-wrap gap-1 border-b border-hairline">
        {BROWSER_CONTROL_SETTINGS_TABS.map((candidate, index) => {
          const active = candidate === tab;
          return (
            <button
              key={candidate}
              id={`browser-control-tab-${candidate}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="browser-control-tab-panel"
              tabIndex={active ? 0 : -1}
              data-browser-control-tab={candidate}
              onClick={() => { selectTab(candidate); }}
              onKeyDown={(event) => { onTabKey(event, index); }}
              className={`-mb-px min-h-9 border-b-2 px-3 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11 ${
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
      <div id="browser-control-tab-panel" role="tabpanel" aria-labelledby={`browser-control-tab-${tab}`} data-browser-control-panel={tab} className="space-y-6">
        {tab === 'computer' ? <ComputerControlSection /> : <BrowserSection />}
      </div>
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
  const [adding, setAdding] = useState(false);

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
      {/* The header is the first row of the tab: the switch's own words, the
          verdict as its help — so the card carries no title of its own. */}
      <SectionCard id="st-card-browser-enabled" title="">
        <CapabilityHeader
          title={t('st.browser.enabledLabel')}
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

      <SectionCard id="st-card-browser-connections" title={t('st.browser.connectionsTitle')} actions={<AddBrowserAction onOpen={() => { setAdding(true); }} />}>
        <BrowserConnectionCard adding={adding} onAddingChange={setAdding} />
        <AdvancedDetails summary={t('st.browser.advanced')} data-browser-advanced-fold>
          <div className="space-y-4 pt-1">
            <BrowserToolPolicy enabled={isEnabled} />
          </div>
        </AdvancedDetails>
      </SectionCard>
    </>
  );
}
