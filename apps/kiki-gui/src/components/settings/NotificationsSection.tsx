import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { NotificationChannel, NotificationDelivery } from '@kiki/klient';
import type { ImSessionSnapshot } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { FeedbackLine } from '../controls';
import { Icon } from '../icons';
import { SidePanel } from '../SidePanel';
import { SECONDARY_BUTTON } from '../ui';
import { AddChannelForm } from './notifications/AddChannelForm';
import { AwayNotificationsCard } from './notifications/AwayNotificationsCard';
import { ChannelRow } from './notifications/ChannelRow';
import { channelState, isAddable, providerLabel, sortedChannels } from './notifications/model';
import { ImSessionCard } from './notifications/ImSessionCard';
import { NotificationRulesCard } from './notifications/NotificationRulesCard';
import { SceneMatrix } from './notifications/SceneMatrix';
import { useNotificationData } from './notifications/useNotifications';
import { SectionCard, SettingsFlashContext } from './SectionCard';
import { ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec, type ListSortSpec } from './list';

const ADD_CARD = 'st-card-notify-add';

type ChannelEntry = readonly [string, NotificationChannel];

/**
 * Three questions, one tab each: where can Kiki reach me (chat accounts and
 * push channels, with their credentials and health), when should it (the
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

/** States a channel can be in that ask the user to do something. */
const ATTENTION = new Set(['dependency', 'unauthorized', 'connection', 'noCredential']);

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
 * Settings → Notifications & messages: Channels & accounts (two-way chat
 * accounts, then one-way push channels), When to notify (the shared rules and
 * the channel × moment table), and This device (system notifications).
 */
export function NotificationsSection() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const { settings, providers, deliveries } = useNotificationData();
  const { hash, search } = useLocation();
  const flashId = useContext(SettingsFlashContext);
  const target = hash === `#${ADD_CARD}` || flashId === ADD_CARD;
  const [adding, setAdding] = useState(target);
  const [opened, setOpened] = useState<string | null>(null);
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
  const imCached = queryClient.getQueryData<ImSessionSnapshot>(['im-sessions']);
  const imNeedsAttention = imCached !== undefined && (
    imCached.discoveries.length > 0 ||
    imCached.instances.some((inst) => (inst.inbound_diagnostics?.length ?? 0) > 0 || inst.connection === 'auth_expired' || (inst.listening && (inst.connection === 'stopped' || inst.adapter === 'stopped' || inst.adapter === 'missing')))
  );
  const pushPaused = data !== undefined && !data.global.enabled;
  const registry = useMemo(() => providers.data ?? [], [providers.data]);
  const channels = useMemo<readonly ChannelEntry[]>(() => (data === undefined ? [] : sortedChannels(data)), [data]);
  const byChannel = new Map<string, NotificationDelivery[]>();
  for (const row of deliveries.data ?? []) byChannel.set(row.channel_id, [...(byChannel.get(row.channel_id) ?? []), row]);
  const canAdd = registry.some(isAddable);

  const providerOf = useCallback(
    (channel: NotificationChannel) => registry.find((provider) => provider.id === data?.provider_instances[channel.provider_instance_id]?.provider_id),
    [registry, data],
  );
  const nameOf = useCallback(([, channel]: ChannelEntry) => {
    const instance = data?.provider_instances[channel.provider_instance_id];
    return channel.label ?? instance?.label ?? providerLabel(t, instance?.provider_id ?? '');
  }, [data, t]);
  const keyOf = useCallback(([id]: ChannelEntry) => id, []);
  const textOf = useCallback((entry: ChannelEntry) => [nameOf(entry), providerOf(entry[1])?.id], [nameOf, providerOf]);
  const filters = useMemo<readonly ListFilterSpec<ChannelEntry>[]>(() => [
    { id: 'enabled', label: t('st.notify.filter.enabled'), test: ([, channel]) => channel.enabled },
    { id: 'disabled', label: t('st.notify.filter.disabled'), test: ([, channel]) => !channel.enabled },
    {
      id: 'attention', label: t('st.notify.filter.attention'), tone: 'attention',
      test: ([, channel]) => data !== undefined && ATTENTION.has(channelState(channel, data.provider_instances[channel.provider_instance_id], providerOf(channel), data.credential_slots)),
    },
  ], [t, data, providerOf]);
  const sorts = useMemo<readonly ListSortSpec<ChannelEntry>[]>(() => [
    { id: 'order', label: t('st.list.sort.order'), compare: () => 0 },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => nameOf(a).localeCompare(nameOf(b)) },
  ], [t, nameOf]);
  const view = useListView({ listId: 'notify-channels', items: channels, keyOf, textOf, filters, sorts });
  const channelsNeedAttention = data !== undefined && channels.some(([, channel]) =>
    ATTENTION.has(channelState(channel, data.provider_instances[channel.provider_instance_id], providerOf(channel), data.credential_slots)));
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

      {panel('accounts', <>
        <ImSessionCard />
        {pushBody ?? (data === undefined ? null : (
          <SectionCard
            id="st-card-notify-channels"
            title={t('st.notify.pushTitle')}
            actions={canAdd && !adding ? (
              <button type="button" data-notify-add-open className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                onClick={() => { setAdding(true); }}>
                <Icon name="plus" size={12} />
                {t('st.notify.choose')}
              </button>
            ) : undefined}
          >
            <div className="space-y-3">
              <p className="text-[12px] leading-4 text-ink-faint">{t('st.notify.pushHint')}</p>
              {!data.global.enabled ? (
                <p className="text-[12px] text-amber-ink" data-notify-paused-banner>{t('st.notify.paused')}</p>
              ) : null}
              {channels.length > 0 ? (
                <>
                  <ListToolbar view={view} total={channels.length} filters={filters} sorts={sorts}
                    searchLabel={t('st.notify.search')} searchPlaceholder={t('st.notify.searchPlaceholder')} />
                  {view.visible.length === 0 ? (
                    <ListEmpty kind="no-match" title={t('st.notify.noMatchTitle')}
                      body={view.query.trim() !== '' ? t('st.notify.noMatches', { query: view.query.trim() }) : undefined}
                      onClear={view.clear} />
                  ) : (
                    <div data-notify-channels className={data.global.enabled ? '' : 'opacity-60'}>
                      <ListBody items={view.visible} keyOf={keyOf} density={view.density} label={t('st.notify.pushTitle')}
                        virtualizeAfter={Number.POSITIVE_INFINITY}
                        renderRow={([id, channel]) => (
                          <ChannelRow channelId={id} channel={channel} settings={data}
                            provider={providerOf(channel)}
                            deliveries={byChannel.get(id) ?? []} defaultOpen={opened === id} density={view.density} />
                        )} />
                    </div>
                  )}
                </>
              ) : !adding ? (
                <div data-notify-empty>
                  <ListEmpty kind="none" title={t('st.notify.emptyTitle')} body={t('st.notify.emptyBody')} />
                </div>
              ) : null}
            </div>
          </SectionCard>
        ))}
      </>)}

      {panel('rules', pushBody ?? (data === undefined ? null : <>
        <NotificationRulesCard global={data.global} />
        <SceneMatrix settings={data} />
      </>))}

      {panel('device', <AwayNotificationsCard />)}

      {adding && data !== undefined ? (
        <SidePanel
          title={t('st.notify.addTitle')}
          overlayId="settings-add-notify-channel"
          onClose={() => { setAdding(false); }}
        >
          <div id="st-card-notify-add">
            <AddChannelForm settings={data} providers={registry}
              onDone={(channelId) => { setAdding(false); if (channelId !== null) setOpened(channelId); }} />
          </div>
        </SidePanel>
      ) : null}
    </div>
  );
}
