import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { NotificationChannel, NotificationDelivery } from '@kiki/klient';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { FeedbackLine } from '../controls';
import { Icon } from '../icons';
import { SidePanel } from '../SidePanel';
import { SECONDARY_BUTTON } from '../ui';
import { AddChannelForm } from './notifications/AddChannelForm';
import { AwayNotificationsCard } from './notifications/AwayNotificationsCard';
import { ChannelRow } from './notifications/ChannelRow';
import { channelState, isAddable, providerLabel, sortedChannels } from './notifications/model';
import { NotificationRulesCard } from './notifications/NotificationRulesCard';
import { useNotificationData } from './notifications/useNotifications';
import { SectionCard, SettingsFlashContext } from './SectionCard';
import { ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec, type ListSortSpec } from './list';

const ADD_CARD = 'st-card-notify-add';

type ChannelEntry = readonly [string, NotificationChannel];

/** States a channel can be in that ask the user to do something. */
const ATTENTION = new Set(['dependency', 'unauthorized', 'connection', 'noCredential']);

/**
 * Settings → Notifications & messages. This device's system notifications
 * first (they need no channel setup), then nb-IM: rules every channel shares, the
 * channel list rendered from the provider registry, and the add form for
 * built-in channels. Receiving replies is not part of this
 * release, so nothing here offers it.
 */
export function NotificationsSection() {
  const { t, locale } = useI18n();
  const { settings, providers, deliveries } = useNotificationData();
  const { hash } = useLocation();
  const flashId = useContext(SettingsFlashContext);
  const target = hash === `#${ADD_CARD}` || flashId === ADD_CARD;
  const [adding, setAdding] = useState(target);
  const [opened, setOpened] = useState<string | null>(null);
  // A search hit or deep link to the add card opens the form it points at.
  useEffect(() => { if (target) setAdding(true); }, [target]);

  const data = settings.data;
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

  if (settings.isError || providers.isError) {
    return <><AwayNotificationsCard /><FeedbackLine feedback={{ tone: 'error', text: t('st.notify.loadFailed', { detail: errorText(locale, settings.error ?? providers.error) }) }} /></>;
  }
  if (data === undefined || providers.data === undefined) return <><AwayNotificationsCard /><div data-notify-loading aria-busy="true" className="min-h-40" /></>;

  return (
    <>
      <AwayNotificationsCard />
      <NotificationRulesCard global={data.global} />
      <SectionCard id="st-card-notify-channels" title={t('st.notify.channelsTitle')}>
        <div className="space-y-3">
          {channels.length > 0 ? (
            <>
              <ListToolbar view={view} total={channels.length} filters={filters} sorts={sorts}
                searchLabel={t('st.notify.search')} searchPlaceholder={t('st.notify.searchPlaceholder')}
                actions={canAdd && !adding ? (
                  <button type="button" data-notify-add-open className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                    onClick={() => { setAdding(true); }}>
                    <Icon name="plus" size={12} />
                    {t('st.notify.choose')}
                  </button>
                ) : undefined} />
              {view.visible.length === 0 ? (
                <ListEmpty kind="no-match" title={t('st.notify.noMatchTitle')}
                  body={view.query.trim() !== '' ? t('st.notify.noMatches', { query: view.query.trim() }) : undefined}
                  onClear={view.clear} />
              ) : (
                <div data-notify-channels>
                  <ListBody items={view.visible} keyOf={keyOf} density={view.density} label={t('st.notify.channelsTitle')}
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
            <>
              <div data-notify-empty>
                <ListEmpty kind="none" title={t('st.notify.emptyTitle')} body={t('st.notify.emptyBody')} />
              </div>
              {canAdd ? (
                <button type="button" data-notify-add-open className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                  onClick={() => { setAdding(true); }}>
                  <Icon name="plus" size={12} />
                  {t('st.notify.choose')}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </SectionCard>
      {adding ? (
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
    </>
  );
}
