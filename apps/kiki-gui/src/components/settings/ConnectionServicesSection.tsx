/**
 * Settings › Access from elsewhere (`connection-services`).
 *
 * Everything that lets something outside reach this Kiki, split by who is
 * connecting: a browser on another device (plus the tunnel that can give it
 * an address), another Kiki, or an agent / MCP client calling this Kiki's
 * tools. Each card still writes the same server object it always did; the
 * tabs only decide which question the reader is answering.
 */

import { useRef } from 'react';
import { useLocation } from 'react-router-dom';

import {
  CONNECTION_SERVICES_SETTINGS_DEFAULT_TAB,
  CONNECTION_SERVICES_SETTINGS_TABS,
  connectionServicesTabLabelKey,
  normalizeConnectionServicesTab,
  type ConnectionServicesSettingsTab,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useGuardedNavigate } from '../dirtyGuard';
import { ExternalClientsSection } from './ExternalClientsSection';
import { ExternalConnectionSection } from './ExternalConnectionSection';
import { InboundConnectionsSection } from './InboundConnectionsSection';
import { RemoteConnectionsSection } from './RemoteConnectionsSection';
import { WebAccessSection } from './WebAccessSection';

export function ConnectionServicesSection() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { pathname, search } = useLocation();
  const tab: ConnectionServicesSettingsTab = normalizeConnectionServicesTab(new URLSearchParams(search).get('tab'))
    ?? CONNECTION_SERVICES_SETTINGS_DEFAULT_TAB;
  const tabsRef = useRef<HTMLDivElement>(null);

  const selectTab = (next: ConnectionServicesSettingsTab, focus = false) => {
    if (focus) tabsRef.current?.querySelector<HTMLButtonElement>(`[data-access-tab="${next}"]`)?.focus();
    if (next === tab) return;
    const params = new URLSearchParams(search);
    params.set('tab', next);
    void navigate(`${pathname}?${params.toString()}`);
  };

  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    const last = CONNECTION_SERVICES_SETTINGS_TABS.length - 1;
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    selectTab(CONNECTION_SERVICES_SETTINGS_TABS[target]!, true);
  };

  return (
    <div className="space-y-6">
      <div ref={tabsRef} role="tablist" aria-label={t('st.section.externalAccess')} className="flex flex-wrap gap-1 border-b border-hairline">
        {CONNECTION_SERVICES_SETTINGS_TABS.map((candidate, index) => {
          const active = candidate === tab;
          return (
            <button
              key={candidate}
              id={`access-tab-${candidate}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="access-tab-panel"
              tabIndex={active ? 0 : -1}
              data-access-tab={candidate}
              onClick={() => { selectTab(candidate); }}
              onKeyDown={(event) => { onTabKey(event, index); }}
              className={`-mb-px min-h-9 border-b-2 px-3 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11 ${
                active
                  ? 'border-ink font-medium text-ink'
                  : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {t(connectionServicesTabLabelKey(candidate))}
            </button>
          );
        })}
      </div>
      <div id="access-tab-panel" role="tabpanel" aria-labelledby={`access-tab-${tab}`} data-access-panel={tab} className="space-y-6">
        {tab === 'kiki' ? (
          <>
            {/* One relationship, two directions on one view: who may connect to
                this Kiki first (the gate), then the Kikis this one connects to. */}
            <InboundConnectionsSection />
            <RemoteConnectionsSection />
          </>
        ) : tab === 'clients' ? (
          <ExternalClientsSection />
        ) : (
          <>
            <WebAccessSection />
            <ExternalConnectionSection />
          </>
        )}
      </div>
    </div>
  );
}
