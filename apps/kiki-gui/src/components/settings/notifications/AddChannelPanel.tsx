import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { NotificationProviderDescriptor, NotificationSettings } from '@kiki/klient';
import type { ImSetupCatalog } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { FeedbackLine } from '../../controls';
import { SidePanel } from '../../SidePanel';
import { SECONDARY_BUTTON } from '../../ui';
import { AddChannelForm } from './AddChannelForm';
import {
  addCatalog, BRAND_KEY, brandAvailable, hasBothKinds, routeKey,
  type BrandEntry, type BrandId, type ChannelRoute, type RouteOption,
} from './catalog';
import { IM_KEY } from './imModel';
import { PlatformSetupForm, WechatScan } from './ImSetup';
import { reasonKey } from './model';
import { PasteSetupForm } from './PasteSetupForm';
import { QqPluginSetup } from './QqPluginSetup';
import { CapabilityTag, PlatformMark } from './rowParts';
import { useImAction, useStartListening, type WechatQr } from './useImSessions';

/** What a two-way route is called when a brand offers both kinds. */
function routeTitleKey(route: ChannelRoute): I18nKey {
  if (route.kind === 'im' && route.mode === 'plugin') return 'st.channels.qq.official';
  if (route.kind === 'im' && route.mode === 'paste' && route.paste === 'qq') return 'st.channels.qq.onebot';
  return route.kind === 'im' ? 'st.channels.route.twoWay' : 'st.channels.route.alerts';
}

function routeHintKey(route: ChannelRoute): I18nKey {
  if (route.kind === 'push') return route.providerId === 'telegram' ? 'st.channels.route.alertsBotHint' : 'st.channels.route.alertsHint';
  if (route.mode === 'plugin') return 'st.channels.qq.officialHint';
  if (route.mode === 'paste' && route.paste === 'qq') return 'st.channels.qq.onebotHint';
  return 'st.channels.route.twoWayHint';
}

/**
 * "Add channel": one side panel for every way Kiki can reach the person.
 * Step 1 picks the platform; a platform that can both talk and alert asks
 * which one. Step 2 is that platform's own setup, and every path creates a
 * new account or channel. Re-authorizing an existing one lives in its row.
 */
export function AddChannelPanel({ settings, providers, setupCatalog, setupFailed, onRetrySetup, qr, onClose, onAdded }: {
  settings: NotificationSettings | undefined;
  providers: readonly NotificationProviderDescriptor[];
  setupCatalog: ImSetupCatalog | undefined;
  setupFailed: boolean;
  onRetrySetup: () => void;
  qr: WechatQr;
  onClose: () => void;
  onAdded: (rowKey: string) => void;
}) {
  const { t } = useI18n();
  const brands = useMemo(() => addCatalog(setupCatalog, setupFailed, providers), [setupCatalog, setupFailed, providers]);
  const [brandId, setBrandId] = useState<BrandId | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const brand = brands.find((entry) => entry.id === brandId);
  const usable = brand?.routes.filter((option) => option.unavailable === undefined) ?? [];
  const chosen = brand === undefined ? undefined
    : usable.find((option) => routeKey(option.route) === routeId) ?? (usable.length === 1 || !hasBothKinds(brand) ? usable[0] : undefined);
  const back = () => {
    if (chosen?.route.kind === 'im' && chosen.route.mode === 'wechat' && qr.active) qr.cancel();
    else qr.reset();
    if (routeId !== null && brand !== undefined && hasBothKinds(brand)) setRouteId(null);
    else { setBrandId(null); setRouteId(null); }
  };

  return (
    <SidePanel
      title={brand === undefined ? t('st.channels.add') : t('st.channels.addBrand', { brand: t(BRAND_KEY[brand.id]) })}
      overlayId="settings-add-channel"
      width="lg"
      onClose={onClose}
      data={{ 'data-channel-add': brand === undefined ? 'pick' : brand.id }}
      // Push navigation inside one panel: picking a platform is a step, and
      // Back in the header returns to the grid. No second panel opens.
      back={brand === undefined ? undefined : { label: t('st.channels.backAria'), onClick: back, data: { 'data-channel-back': '' } }}
      stepKey={brand === undefined ? 'pick' : brand.id}
    >
      <div id="st-card-notify-add" className="space-y-5" data-im-connect-drawer>
        {brand === undefined ? (
          <BrandGrid brands={brands} setupFailed={setupFailed} onRetrySetup={onRetrySetup}
            onPick={(id) => { qr.reset(); setBrandId(id); setRouteId(null); }} />
        ) : (
          <>
            {hasBothKinds(brand) ? (
              <RoutePicker brand={brand} value={chosen === undefined ? null : routeKey(chosen.route)}
                onChange={(next) => { qr.reset(); setRouteId(next); }} />
            ) : null}
            {chosen !== undefined ? (
              <RouteSetup key={routeKey(chosen.route)} option={chosen} settings={settings} providers={providers}
                setupCatalog={setupCatalog} qr={qr} onAdded={onAdded} onCancel={onClose} />
            ) : null}
          </>
        )}
      </div>
    </SidePanel>
  );
}

function BrandGrid({ brands, setupFailed, onRetrySetup, onPick }: {
  brands: readonly BrandEntry[];
  setupFailed: boolean;
  onRetrySetup: () => void;
  onPick: (id: BrandId) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-channel-brands>
        {brands.map((brand) => {
          const available = brandAvailable(brand);
          const twoWay = brand.routes.some((option) => option.route.kind === 'im' && option.unavailable === undefined);
          const alerts = brand.routes.some((option) => option.route.kind === 'push' && option.unavailable === undefined);
          const reason = brand.routes.find((option) => option.unavailable !== undefined);
          return (
            <li key={brand.id}>
              <button type="button" disabled={!available} onClick={() => { onPick(brand.id); }}
                data-channel-brand={brand.id} data-unavailable={available ? undefined : 'true'}
                className="flex h-full min-h-[92px] w-full flex-col items-start gap-2.5 rounded-lg border border-hairline bg-panel p-3 text-left transition-[border-color,box-shadow] hover:border-hairline-strong hover:shadow-[var(--kiki-sheet-shadow)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:bg-transparent disabled:hover:border-hairline disabled:hover:shadow-none">
                <span className="flex w-full items-center gap-2.5">
                  <span className={available ? '' : 'opacity-45'}><PlatformMark brand={brand.id} twoWay={twoWay} /></span>
                  <span className={`min-w-0 truncate text-[13px] font-medium ${available ? 'text-ink' : 'text-ink-faint'}`}>{t(BRAND_KEY[brand.id])}</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  {available ? <>
                    {twoWay ? <CapabilityTag twoWay /> : null}
                    {alerts ? <CapabilityTag twoWay={false} /> : null}
                  </> : (
                    <span className="text-[11.5px] leading-4 text-ink-faint" data-notify-unavailable-provider={reason?.route.kind === 'push' ? reason.route.providerId : brand.id}>
                      {reason?.unavailable === 'setupCatalog' ? t('st.channels.unavailable.setup')
                        : t(reasonKey(reason?.reason))}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {setupFailed ? (
        <div className="flex flex-wrap items-center gap-2" data-im-setup-catalog-error>
          <FeedbackLine feedback={{ tone: 'error', text: t('st.im.setup.catalogError') }} />
          <button type="button" className={SECONDARY_BUTTON} data-im-setup-catalog-retry onClick={onRetrySetup}>{t('st.im.retry')}</button>
        </div>
      ) : null}
    </div>
  );
}

function RoutePicker({ brand, value, onChange }: { brand: BrandEntry; value: string | null; onChange: (route: string) => void }) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t('st.channels.routeAria')} className="grid gap-2 sm:grid-cols-2" data-channel-routes>
      {brand.routes.map((option) => {
        const key = routeKey(option.route);
        const selected = key === value;
        const disabled = option.unavailable !== undefined;
        return (
          <button key={key} type="button" role="radio" aria-checked={selected} disabled={disabled}
            data-channel-route={key} onClick={() => { onChange(key); }}
            className={`flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 ${
              selected ? 'border-selected-ink/50 bg-selected/40' : 'border-hairline bg-panel hover:border-hairline-strong'
            }`}>
            <span className="flex items-center gap-2">
              <span aria-hidden className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${selected ? 'border-selected-ink' : 'border-hairline-strong'}`}>
                {selected ? <span className="h-1.5 w-1.5 rounded-full bg-selected-ink" /> : null}
              </span>
              <span className="text-[13px] font-medium text-ink">{t(routeTitleKey(option.route))}</span>
            </span>
            <span className="pl-[22px] text-[12px] leading-4 text-ink-faint">
              {option.unavailable === 'setupCatalog' ? t('st.channels.unavailable.setup')
                : option.unavailable === 'dependency' ? t(reasonKey(option.reason)) : t(routeHintKey(option.route))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RouteSetup({ option, settings, providers, setupCatalog, qr, onAdded, onCancel }: {
  option: RouteOption;
  settings: NotificationSettings | undefined;
  providers: readonly NotificationProviderDescriptor[];
  setupCatalog: ImSetupCatalog | undefined;
  qr: WechatQr;
  onAdded: (rowKey: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const action = useImAction();
  const startListening = useStartListening();
  const [savedId, setSavedId] = useState<string>();
  const { route } = option;

  if (route.kind === 'push') {
    const provider = providers.find((item) => item.id === route.providerId);
    if (provider === undefined || settings === undefined) return <p className="text-[13px] text-ink-soft">{t('st.notify.loadFailed', { detail: '' })}</p>;
    return <AddChannelForm settings={settings} provider={provider}
      onDone={(channelId) => { if (channelId === null) onCancel(); else onAdded(`push:${channelId}`); }} />;
  }
  if (route.mode === 'wechat') {
    return (
      <div className="space-y-3" data-im-setup-route="wechat">
        <p className="text-center text-[13px] text-ink-soft">{t('st.channels.wechat.scanHint')}</p>
        <WechatScan qr={qr} />
      </div>
    );
  }
  if (route.mode === 'plugin') return <QqPluginSetup />;
  if (route.mode === 'paste') {
    return <PasteSetupForm kind={route.paste} onConnected={(id) => { onAdded(`im:${id}`); }} />;
  }
  const platform = setupCatalog?.platforms.find((item) => item.provider_kind === route.provider);
  if (platform === undefined) return null;
  return (
    <>
      <PlatformSetupForm platform={platform} savedInstanceId={savedId} busy={action.saving}
        onSaved={async (result) => { setSavedId(result.provider_instance_id); await queryClient.invalidateQueries({ queryKey: IM_KEY }); }}
        onCheckAndListen={(id) => {
          void action.run(async () => {
            const next = await startListening(id);
            onAdded(`im:${id}`);
            return next;
          });
        }} />
      <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
    </>
  );
}
