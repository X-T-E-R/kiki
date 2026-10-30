import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { NotificationChannel, NotificationDelivery, NotificationSettings } from '@kiki/klient';
import type { ImSessionSnapshot } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine } from '../../controls';
import { Icon } from '../../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { ListBody, ListEmpty, ListToolbar, useListView, type ListFilterSpec } from '../list';
import { SectionCard, SettingsCardMountContext } from '../SectionCard';
import { AddChannelPanel } from './AddChannelPanel';
import { BRAND_ORDER, brandOfIm, brandOfPush } from './catalog';
import { ChannelRow } from './ChannelRow';
import { ImAccountRow } from './ImAccountRow';
import { IM_KEY, instanceDisplayName, instanceNeedsAttention, instanceState, requestedTarget, type ImInstanceStatus } from './imModel';
import { ImRules } from './ImRules';
import { channelState, providerLabel, sortedChannels } from './model';
import { useImData, useStartListening, useWechatQr } from './useImSessions';
import { useNotificationData } from './useNotifications';

export const ATTENTION_STATES: ReadonlySet<string> = new Set(['dependency', 'unauthorized', 'connection', 'noCredential']);

type Entry =
  | { readonly kind: 'im'; readonly key: string; readonly account: ImInstanceStatus; readonly name: string; readonly rank: number; readonly attention: boolean }
  | { readonly kind: 'push'; readonly key: string; readonly id: string; readonly channel: NotificationChannel; readonly name: string; readonly rank: number; readonly attention: boolean };

/** Lists past this many rows get search and filter chips; short ones stay quiet. */
const TOOLBAR_AFTER = 6;

/**
 * Two-way accounts a bare Telegram push bot also shows up as: the IM layer
 * lists every Telegram connection, but one that only feeds alert channels and
 * never talked is that channel's connection, not a second account.
 */
function isShadowAccount(account: ImInstanceStatus, data: ImSessionSnapshot, push: NotificationSettings | undefined): boolean {
  if (account.provider_kind !== 'telegram' || account.listening || push === undefined) return false;
  if (data.bindings.some((item) => item.provider_instance_id === account.id) || data.discoveries.some((item) => item.provider_instance_id === account.id)) return false;
  return Object.values(push.channels).some((channel) => channel.provider_instance_id === account.id);
}

/**
 * "My channels": every way Kiki can reach the person, as one list. A chat
 * account Kiki can talk on and an alert-only channel sit side by side, each
 * row marked with what it can do; one "Add channel" creates either.
 */
export function ChannelsCard({ adding, setAdding }: { adding: boolean; setAdding: (open: boolean) => void }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const onCardMount = useContext(SettingsCardMountContext);
  const { snapshot, catalog, setupCatalog } = useImData();
  const { settings, providers, deliveries } = useNotificationData();
  const startListening = useStartListening();
  const [opened, setOpened] = useState<string | null>(null);
  const [preselected, setPreselected] = useState<Record<string, string>>({});
  const [wechatError, setWechatError] = useState<string>();
  const initialTarget = useMemo(requestedTarget, []);
  const im = snapshot.data;
  const push = settings.data;
  const registry = useMemo(() => providers.data ?? [], [providers.data]);

  useEffect(() => { onCardMount?.('st-card-im-session'); }, [onCardMount]);

  const onWechatConfirmed = useCallback((id: string | undefined) => {
    setAdding(false);
    if (id === undefined) return;
    setOpened(`im:${id}`);
    void (async () => {
      try {
        const fresh = await client.imSessions.snapshot();
        queryClient.setQueryData(IM_KEY, fresh);
        const account = fresh.instances.find((item) => item.id === id && item.provider_kind === 'wechat_bridge');
        if (account === undefined || instanceState(account) === 'listening') return;
        queryClient.setQueryData(IM_KEY, await startListening(account.id));
      } catch (caught) {
        setWechatError(caught instanceof Error && caught.message !== '' ? caught.message : t('st.im.error'));
      }
    })();
  }, [client, queryClient, setAdding, startListening, t]);
  const qr = useWechatQr(onWechatConfirmed);

  const byChannel = useMemo(() => {
    const map = new Map<string, NotificationDelivery[]>();
    for (const row of deliveries.data ?? []) map.set(row.channel_id, [...(map.get(row.channel_id) ?? []), row]);
    return map;
  }, [deliveries.data]);

  const providerOf = useCallback((channel: NotificationChannel) =>
    registry.find((provider) => provider.id === push?.provider_instances[channel.provider_instance_id]?.provider_id), [registry, push]);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    if (im !== undefined) {
      const accounts = [...im.instances];
      for (const item of [...im.bindings, ...im.discoveries]) {
        if (!accounts.some((account) => account.id === item.provider_instance_id)) {
          accounts.push({ id: item.provider_instance_id, provider_kind: item.provider_kind, account_id: item.account_id, configured: false, listening: false, adapter: 'missing' });
        }
      }
      for (const account of accounts) {
        if (isShadowAccount(account, im, push)) continue;
        const discoveries = im.discoveries.filter((item) => item.provider_instance_id === account.id).length;
        list.push({
          kind: 'im', key: `im:${account.id}`, account, name: instanceDisplayName(account, t),
          rank: BRAND_ORDER.indexOf(brandOfIm(account.provider_kind)), attention: instanceNeedsAttention(account, discoveries),
        });
      }
    }
    if (push !== undefined) {
      for (const [id, channel] of sortedChannels(push)) {
        const instance = push.provider_instances[channel.provider_instance_id];
        const state = channelState(channel, instance, providerOf(channel), push.credential_slots);
        list.push({
          kind: 'push', key: `push:${id}`, id, channel, name: channel.label ?? instance?.label ?? providerLabel(t, instance?.provider_id ?? ''),
          rank: BRAND_ORDER.indexOf(brandOfPush(instance?.provider_id ?? '')), attention: ATTENTION_STATES.has(state),
        });
      }
    }
    return list.toSorted((a, b) => (a.kind === b.kind ? 0 : a.kind === 'im' ? -1 : 1) || a.rank - b.rank || a.name.localeCompare(b.name));
  }, [im, push, providerOf, t]);

  const keyOf = useCallback((entry: Entry) => entry.key, []);
  const textOf = useCallback((entry: Entry) => [entry.name, entry.kind === 'im' ? entry.account.account_id : providerOf(entry.channel)?.id], [providerOf]);
  const filters = useMemo<readonly ListFilterSpec<Entry>[]>(() => [
    { id: 'two-way', label: t('st.channels.cap.twoWay'), test: (entry) => entry.kind === 'im' },
    { id: 'alerts', label: t('st.channels.cap.alerts'), test: (entry) => entry.kind === 'push' },
    { id: 'attention', label: t('st.notify.filter.attention'), tone: 'attention', test: (entry) => entry.attention },
  ], [t]);
  const view = useListView({ listId: 'notify-channels', items: entries, keyOf, textOf, filters });

  const loading = im === undefined && !snapshot.isError && push === undefined && !settings.isError;
  const pushFailed = settings.isError || providers.isError;
  const addButton = (
    <button type="button" data-notify-add-open data-im-connect-toggle className={`${PRIMARY_BUTTON} inline-flex items-center gap-1.5`}
      aria-expanded={adding} onClick={() => { setAdding(true); }}>
      <Icon name="plus" size={12} />
      {t('st.channels.add')}
    </button>
  );

  return (
    <SectionCard id="st-card-notify-channels" title={t('st.channels.title')} actions={entries.length > 0 ? addButton : undefined}>
      <div id="st-card-im-session" className="min-w-0 space-y-4 scroll-mt-4" data-im-session>
        {snapshot.isError ? <div className="flex flex-wrap items-center gap-2">
          <FeedbackLine feedback={{ tone: 'error', text: t('st.im.loadError') }} />
          <button type="button" className={SECONDARY_BUTTON} data-im-retry onClick={() => { void snapshot.refetch(); }}>{t('st.im.retry')}</button>
        </div> : null}
        {pushFailed ? <FeedbackLine feedback={{ tone: 'error', text: t('st.notify.loadFailed', { detail: errorText(locale, settings.error ?? providers.error) }) }} /> : null}
        {catalog.isError ? <div className="flex flex-wrap items-center gap-2" data-im-catalog-error>
          <FeedbackLine feedback={{ tone: 'error', text: t('st.im.catalogError') }} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void catalog.refetch(); }}>{t('st.im.retry')}</button>
        </div> : null}
        {wechatError !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: wechatError }} /> : null}
        {push !== undefined && !push.global.enabled && entries.some((entry) => entry.kind === 'push') ? (
          <p className="flex items-center gap-1.5 text-[12px] text-amber-ink" data-notify-paused-banner>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-rule" />
            {t('st.channels.alertsPaused')}
          </p>
        ) : null}

        {loading ? <div data-im-loading data-notify-loading aria-busy="true" className="min-h-40" /> : entries.length === 0 ? (
          snapshot.isError ? null : (
            <div data-notify-empty data-im-empty>
              <ListEmpty kind="none" title={t('st.channels.emptyTitle')} body={t('st.channels.emptyBody')} action={addButton} />
            </div>
          )
        ) : (
          <>
            {entries.length > TOOLBAR_AFTER ? (
              <ListToolbar view={view} total={entries.length} filters={filters} showDensity={false}
                searchLabel={t('st.notify.search')} searchPlaceholder={t('st.notify.searchPlaceholder')} />
            ) : null}
            {view.visible.length === 0 ? (
              <ListEmpty kind="no-match" title={t('st.notify.noMatchTitle')}
                body={view.query.trim() !== '' ? t('st.notify.noMatches', { query: view.query.trim() }) : undefined} onClear={view.clear} />
            ) : (
              <div data-notify-channels data-im-accounts>
                <ListBody items={view.visible} keyOf={keyOf} density="comfortable" label={t('st.channels.title')}
                  virtualizeAfter={Number.POSITIVE_INFINITY}
                  renderRow={(entry) => entry.kind === 'im' && im !== undefined ? (
                    <ImAccountRow account={entry.account} data={im} catalog={catalog.data}
                      setupPlatform={setupCatalog.data?.platforms.find((item) => item.provider_kind === entry.account.provider_kind)}
                      initialTarget={initialTarget} preselectedTarget={preselected[entry.account.id]}
                      onPreselectTarget={(value) => { setPreselected((current) => ({ ...current, [entry.account.id]: value })); }}
                      open={opened === entry.key} onToggle={() => { setOpened((current) => current === entry.key ? null : entry.key); }} />
                  ) : entry.kind === 'push' && push !== undefined ? (
                    <ChannelRow channelId={entry.id} channel={entry.channel} settings={push} provider={providerOf(entry.channel)}
                      deliveries={byChannel.get(entry.id) ?? []} open={opened === entry.key} onToggle={() => { setOpened((current) => current === entry.key ? null : entry.key); }} />
                  ) : null} />
              </div>
            )}
          </>
        )}

        {im !== undefined ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <ImRules policy={im.policy} />
            {im.strangers.length > 0 || im.voice_fallbacks > 0 ? (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-faint">
                {im.strangers.length > 0 ? <span data-im-strangers>{t('st.im.strangers')}: {im.strangers.reduce((sum, item) => sum + item.count, 0)}</span> : null}
                {im.voice_fallbacks > 0 ? <span data-im-voice>{t('st.im.voice')}: {im.voice_fallbacks}</span> : null}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {adding ? (
        <AddChannelPanel settings={push} providers={registry} setupCatalog={setupCatalog.data} setupFailed={setupCatalog.isError}
          onRetrySetup={() => { void setupCatalog.refetch(); }} qr={qr}
          onClose={() => { setAdding(false); }}
          onAdded={(rowKey) => { setAdding(false); setOpened(rowKey); void queryClient.invalidateQueries({ queryKey: IM_KEY }); }} />
      ) : null}
    </SectionCard>
  );
}
