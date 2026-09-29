import { useState } from 'react';
import type { NotificationDelivery } from '@kiki/klient';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { FeedbackLine } from '../controls';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { AddChannelForm } from './notifications/AddChannelForm';
import { ChannelRow } from './notifications/ChannelRow';
import { isAddable, sortedChannels } from './notifications/model';
import { NotificationRulesCard } from './notifications/NotificationRulesCard';
import { useNotificationData } from './notifications/useNotifications';
import { SectionCard } from './SectionCard';

/**
 * Settings → Notifications & messages (nb-IM). Rules every channel shares on
 * top, then the channel list rendered from the provider registry, then the
 * add form for built-in channels. Receiving replies is not part of this
 * release, so nothing here offers it.
 */
export function NotificationsSection() {
  const { t, locale } = useI18n();
  const { settings, providers, deliveries } = useNotificationData();
  const [adding, setAdding] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

  if (settings.isError || providers.isError) {
    return <FeedbackLine feedback={{ tone: 'error', text: t('st.notify.loadFailed', { detail: errorText(locale, settings.error ?? providers.error) }) }} />;
  }
  if (settings.data === undefined || providers.data === undefined) return <div data-notify-loading aria-busy="true" className="min-h-40" />;

  const data = settings.data;
  const registry = providers.data;
  const channels = sortedChannels(data);
  const byChannel = new Map<string, NotificationDelivery[]>();
  for (const row of deliveries.data ?? []) byChannel.set(row.channel_id, [...(byChannel.get(row.channel_id) ?? []), row]);
  const canAdd = registry.some(isAddable);

  return (
    <>
      <NotificationRulesCard global={data.global} />
      <SectionCard id="st-card-notify-channels" title={t('st.notify.channelsTitle')}>
        <div className="space-y-3">
          {channels.length > 0 ? (
            <div data-notify-channels className="overflow-hidden rounded-lg border border-hairline bg-panel">
              {channels.map(([id, channel]) => (
                <ChannelRow key={id} channelId={id} channel={channel} settings={data}
                  provider={registry.find((provider) => provider.id === data.provider_instances[channel.provider_instance_id]?.provider_id)}
                  deliveries={byChannel.get(id) ?? []} defaultOpen={opened === id} />
              ))}
            </div>
          ) : !adding ? (
            <div data-notify-empty className="rounded-lg border border-dashed border-hairline-strong px-4 py-5">
              <p className="text-[13px] font-medium text-ink">{t('st.notify.emptyTitle')}</p>
              <p className="mt-1 max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.notify.emptyBody')}</p>
            </div>
          ) : null}
          {canAdd && !adding ? (
            <button type="button" data-notify-add-open className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
              onClick={() => { setAdding(true); }}>
              <Icon name="plus" size={12} />
              {t('st.notify.choose')}
            </button>
          ) : null}
        </div>
      </SectionCard>
      {adding ? (
        <SectionCard id="st-card-notify-add" title={t('st.notify.addTitle')}>
          <AddChannelForm settings={data} providers={registry}
            onDone={(channelId) => { setAdding(false); if (channelId !== null) setOpened(channelId); }} />
        </SectionCard>
      ) : null}
    </>
  );
}
