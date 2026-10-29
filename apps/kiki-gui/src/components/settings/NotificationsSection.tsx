import { useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { ImSessionSnapshot } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { FeedbackLine } from '../controls';
import { AwayNotificationsCard } from './notifications/AwayNotificationsCard';
import { ATTENTION_STATES, ChannelsCard } from './notifications/ChannelsCard';
import { IM_KEY, instanceNeedsAttention } from './notifications/imModel';
import { channelState } from './notifications/model';
import { NotificationRulesCard } from './notifications/NotificationRulesCard';
import { SceneMatrix } from './notifications/SceneMatrix';
import { useNotificationData } from './notifications/useNotifications';
import { SettingsFlashContext } from './SectionCard';

const ADD_CARD = 'st-card-notify-add';

/**
 * Three questions, one tab each: where can Kiki reach me and can I answer
 * (every channel, with its credentials and health), when should it (the
 * shared rules and which channel hears which moment), and what does this
 * device do on its own (system notifications).
 */
type NotifySubTab = 'accounts' | 'rules' | 'device';

const NOTIFY_TABS: readonly NotifySubTab[] = ['accounts', 'rules', 'device'];

/** Earlier `?tab=` values: two-way chat and push channels are both accounts now. */
const LEGACY_TABS: Readonly<Record<string, NotifySubTab>> = { im: 'accounts', channels: 'accounts', away: 'device' };

function tabFromQuery(value: string | null): NotifySubTab | undefined {
  if (value === null) return undefined;
  return NOTIFY_TABS.find((tab) => tab === value) ?? LEGACY_TABS[value];
}

const CARD_TO_TAB: Readonly<Record<string, NotifySubTab>> = {
  'st-card-im-session': 'accounts',
  'st-card-notify-channels': 'accounts',
  'st-card-notify-add': 'accounts',
  'st-card-notify-rules': 'rules',
  'st-card-notify-scenes': 'rules',
  'st-card-notify-away': 'device',
};

function resolveInitialTab(search: string, hash: string, flashId: string | null): NotifySubTab {
  const cleanHash = hash.replace(/^#/, '');
  if (cleanHash !== '' && CARD_TO_TAB[cleanHash] !== undefined) {
    return CARD_TO_TAB[cleanHash]!;
  }
  if (flashId !== null && CARD_TO_TAB[flashId] !== undefined) {
    return CARD_TO_TAB[flashId]!;
  }
  return tabFromQuery(new URLSearchParams(search).get('tab')) ?? 'accounts';
}

function tabLabelKey(tab: NotifySubTab): I18nKey {
  switch (tab) {
    case 'accounts':
      return 'st.notify.tab.accounts';
    case 'rules':
      return 'st.notify.tab.rules';
    case 'device':
      return 'st.notify.tab.device';
  }
}

/**
 * Settings → Notifications & messages: Channels & accounts (one list of every
 * channel, two-way or alerts only, with one add entry), When to notify (the
 * shared rules and the channel × moment table), and This device (system
 * notifications).
 */
export function NotificationsSection() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const { settings, providers } = useNotificationData();
  const { hash, search } = useLocation();
  const flashId = useContext(SettingsFlashContext);
  const target = hash === `#${ADD_CARD}` || flashId === ADD_CARD;
  const [adding, setAdding] = useState(target);
  const [activeTab, setActiveTab] = useState<NotifySubTab>(() => resolveInitialTab(search, hash, flashId));
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanHash = hash.replace(/^#/, '');
    if (cleanHash !== '' && CARD_TO_TAB[cleanHash] !== undefined) {
      setActiveTab(CARD_TO_TAB[cleanHash]!);
      return;
    }
    if (flashId !== null && CARD_TO_TAB[flashId] !== undefined) {
      setActiveTab(CARD_TO_TAB[flashId]!);
      return;
    }
    const fromQuery = tabFromQuery(new URLSearchParams(search).get('tab'));
    if (fromQuery !== undefined) setActiveTab(fromQuery);
  }, [hash, flashId, search]);

  // A search hit or deep link to the add card opens the form it points at.
  useEffect(() => { if (target) setAdding(true); }, [target]);

  const data = settings.data;
  const imCached = queryClient.getQueryData<ImSessionSnapshot>(IM_KEY);
  const imNeedsAttention = imCached !== undefined && imCached.instances.some((inst) =>
    instanceNeedsAttention(inst, imCached.discoveries.filter((item) => item.provider_instance_id === inst.id).length));
  const pushPaused = data !== undefined && !data.global.enabled;
  const registry = providers.data ?? [];
  const channelsNeedAttention = data !== undefined && Object.values(data.channels).some((channel) => ATTENTION_STATES.has(channelState(
    channel, data.provider_instances[channel.provider_instance_id],
    registry.find((provider) => provider.id === data.provider_instances[channel.provider_instance_id]?.provider_id), data.credential_slots)));
  const panel = (tab: NotifySubTab, children: React.ReactNode) => (
    <div id={`notify-panel-${tab}`} role="tabpanel" aria-labelledby={`notify-tab-${tab}`} className={activeTab === tab ? 'space-y-5' : 'hidden'}>
      {children}
    </div>
  );

  const focusTab = (index: number) => {
    const buttons = tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[index]?.focus();
  };

  const handleTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const nextIndex = (index + 1) % NOTIFY_TABS.length;
      setActiveTab(NOTIFY_TABS[nextIndex]!);
      focusTab(nextIndex);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const prevIndex = (index - 1 + NOTIFY_TABS.length) % NOTIFY_TABS.length;
      setActiveTab(NOTIFY_TABS[prevIndex]!);
      focusTab(prevIndex);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveTab(NOTIFY_TABS[0]!);
      focusTab(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      const lastIndex = NOTIFY_TABS.length - 1;
      setActiveTab(NOTIFY_TABS[lastIndex]!);
      focusTab(lastIndex);
    }
  };

  const tabBar = (
    <div
      ref={tabsRef}
      role="tablist"
      aria-label={t('st.section.notifications')}
      className="flex flex-wrap items-center gap-1 border-b border-hairline pb-px text-[12.5px]"
    >
      {NOTIFY_TABS.map((tab, index) => {
        const active = tab === activeTab;
        return (
          <button
            key={tab}
            id={`notify-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`notify-panel-${tab}`}
            tabIndex={active ? 0 : -1}
            data-notify-tab={tab}
            onClick={() => { setActiveTab(tab); }}
            onKeyDown={(event) => { handleTabKeyDown(event, index); }}
            className={`relative -mb-px flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 ${
              active
                ? 'border-ink font-medium text-ink'
                : 'border-transparent text-ink-soft hover:border-hairline hover:text-ink'
            }`}
          >
            <span>{t(tabLabelKey(tab))}</span>
            {tab === 'accounts' && (imNeedsAttention || channelsNeedAttention) ? (
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-ink" data-notify-tab-attention="accounts" />
            ) : null}
            {tab === 'rules' && pushPaused ? (
              <span className="text-[11px] font-normal text-ink-faint" data-notify-tab-paused>
                {t('st.notify.pausedShort')}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );

  const pushBody = settings.isError || providers.isError
    ? <FeedbackLine feedback={{ tone: 'error', text: t('st.notify.loadFailed', { detail: errorText(locale, settings.error ?? providers.error) }) }} />
    : data === undefined || providers.data === undefined ? <div data-notify-loading aria-busy="true" className="min-h-40" /> : null;

  return (
    <div className="space-y-5">
      {tabBar}

      {panel('accounts', <ChannelsCard adding={adding} setAdding={setAdding} />)}

      {panel('rules', pushBody ?? (data === undefined ? null : <>
        <NotificationRulesCard global={data.global} />
        <SceneMatrix settings={data} />
      </>))}

      {panel('device', <AwayNotificationsCard />)}

    </div>
  );
}
