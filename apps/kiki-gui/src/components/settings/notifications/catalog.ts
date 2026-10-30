/**
 * The one platform catalog behind "Add channel". Two registries feed it: the
 * two-way chat setups (WeChat QR, the setup catalog's Discord/Slack/Matrix
 * bots, and the paste formats for Telegram, Feishu and QQ) and the one-way
 * notification providers. A brand that exists in both offers both routes, so
 * the person picks the platform first and the capability second.
 */

import type { NotificationProviderDescriptor } from '@kiki/klient';
import type { ImProviderKind, ImSetupCatalog, ImSetupProvider } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { isAddable, NEVER_ADDABLE } from './model';

export type BrandId =
  | 'wechat' | 'telegram' | 'feishu' | 'qq' | 'discord' | 'slack' | 'matrix'
  | 'wecom' | 'dingtalk' | 'http' | 'email' | 'windows' | 'other' | 'plugin';

/** How a paste-based two-way setup composes the server's paste text. */
export type PasteKind = 'telegram' | 'feishu' | 'qq' | 'raw';

export type ImRoute =
  | { readonly kind: 'im'; readonly mode: 'wechat' }
  | { readonly kind: 'im'; readonly mode: 'setup'; readonly provider: ImSetupProvider }
  | { readonly kind: 'im'; readonly mode: 'paste'; readonly paste: PasteKind }
  /** A channel a plugin sets up in its own panel (the official QQ bot through kiki-qq). */
  | { readonly kind: 'im'; readonly mode: 'plugin'; readonly pluginId: string };

export interface PushRoute {
  readonly kind: 'push';
  readonly providerId: string;
}

export type ChannelRoute = ImRoute | PushRoute;

export interface RouteOption {
  readonly route: ChannelRoute;
  /** Listed but not offered; the reason names why. */
  readonly unavailable?: 'setupCatalog' | 'dependency';
  readonly reason?: string;
}

export interface BrandEntry {
  readonly id: BrandId;
  readonly routes: readonly RouteOption[];
}

/** Display order of the add grid; the list sorts its rows the same way. */
export const BRAND_ORDER: readonly BrandId[] = [
  'wechat', 'telegram', 'feishu', 'qq', 'discord', 'slack', 'matrix',
  'wecom', 'dingtalk', 'http', 'email', 'windows', 'other', 'plugin',
];

/** One localized name per platform: the grid, the panel title and a row without its own name all use it. */
export const BRAND_KEY: Readonly<Record<BrandId, I18nKey>> = {
  wechat: 'st.channels.brand.wechat',
  telegram: 'st.channels.brand.telegram',
  feishu: 'st.channels.brand.feishu',
  qq: 'st.channels.brand.qq',
  discord: 'st.channels.brand.discord',
  slack: 'st.channels.brand.slack',
  matrix: 'st.channels.brand.matrix',
  wecom: 'st.channels.brand.wecom',
  dingtalk: 'st.channels.brand.dingtalk',
  http: 'st.channels.brand.http',
  email: 'st.channels.brand.email',
  windows: 'st.channels.brand.windows',
  other: 'st.channels.brand.other',
  plugin: 'st.channels.brand.plugin',
};

const PUSH_BRAND: Readonly<Record<string, BrandId>> = {
  telegram: 'telegram',
  feishu_webhook: 'feishu',
  discord_webhook: 'discord',
  slack_webhook: 'slack',
  matrix: 'matrix',
  wecom_webhook: 'wecom',
  dingtalk_webhook: 'dingtalk',
  http: 'http',
  smtp: 'email',
  windows_toast: 'windows',
};

const IM_BRAND: Readonly<Record<string, BrandId>> = {
  wechat_bridge: 'wechat',
  telegram: 'telegram',
  feishu_app: 'feishu',
  onebot_v11: 'qq',
  discord: 'discord',
  slack: 'slack',
  matrix: 'matrix',
};

const PASTE_BRAND: Readonly<Partial<Record<BrandId, PasteKind>>> = {
  telegram: 'telegram',
  feishu: 'feishu',
  qq: 'qq',
};

export function brandOfIm(kind: ImProviderKind): BrandId {
  if (kind.startsWith('plugin:kiki-qq/')) return 'qq';
  return IM_BRAND[kind] ?? 'plugin';
}

export function brandOfPush(providerId: string): BrandId {
  return PUSH_BRAND[providerId] ?? 'other';
}

/**
 * Every brand the add panel lists, with its routes in "can talk" then
 * "alerts only" order. Push providers the registry does not know are left
 * out; ones it knows but cannot run yet stay listed as unavailable.
 */
export function addCatalog(
  setup: ImSetupCatalog | undefined,
  setupFailed: boolean,
  providers: readonly NotificationProviderDescriptor[],
): BrandEntry[] {
  const routes = new Map<BrandId, RouteOption[]>();
  const add = (brand: BrandId, option: RouteOption) => { routes.set(brand, [...(routes.get(brand) ?? []), option]); };
  add('wechat', { route: { kind: 'im', mode: 'wechat' } });
  add('qq', { route: { kind: 'im', mode: 'plugin', pluginId: 'kiki-qq' } });
  for (const brand of BRAND_ORDER) {
    const paste = PASTE_BRAND[brand];
    if (paste !== undefined) add(brand, { route: { kind: 'im', mode: 'paste', paste } });
  }
  for (const provider of ['discord', 'slack', 'matrix'] as const) {
    const listed = setup?.platforms.some((item) => item.provider_kind === provider) === true;
    if (listed) add(provider, { route: { kind: 'im', mode: 'setup', provider } });
    else if (setupFailed || setup === undefined) add(provider, { route: { kind: 'im', mode: 'setup', provider }, unavailable: 'setupCatalog' });
  }
  for (const provider of providers) {
    if (NEVER_ADDABLE.has(provider.id)) continue;
    const brand = brandOfPush(provider.id);
    const route: PushRoute = { kind: 'push', providerId: provider.id };
    if (isAddable(provider)) add(brand, { route });
    else if (provider.status === 'dependency_missing') add(brand, { route, unavailable: 'dependency', reason: provider.status_reason });
  }
  add('other', { route: { kind: 'im', mode: 'paste', paste: 'raw' } });
  return BRAND_ORDER.flatMap((id) => {
    const list = routes.get(id);
    return list === undefined ? [] : [{ id, routes: list.toSorted((a, b) => rank(a.route) - rank(b.route)) }];
  });
}

function rank(route: ChannelRoute): number {
  return route.kind === 'im' ? 0 : 1;
}

export function routeKey(route: ChannelRoute): string {
  if (route.kind === 'push') return `push:${route.providerId}`;
  if (route.mode === 'plugin') return `im:plugin:${route.pluginId}`;
  return route.mode === 'wechat' ? 'im:wechat' : route.mode === 'setup' ? `im:${route.provider}` : `im:paste:${route.paste}`;
}

export function brandAvailable(brand: BrandEntry): boolean {
  return brand.routes.some((option) => option.unavailable === undefined);
}

/**
 * A brand with more than one usable route asks which one: a two-way bot or a
 * one-way webhook, or two two-way routes (QQ: the official bot or OneBot).
 */
export function hasBothKinds(brand: BrandEntry): boolean {
  return brand.routes.filter((option) => option.unavailable === undefined).length > 1;
}

/** Paste text in the format the server's paste parser reads (see imSession/paste.ts). */
export function pasteText(kind: PasteKind, values: Readonly<Record<string, string>>): string {
  const value = (key: string) => (values[key] ?? '').trim();
  switch (kind) {
    case 'telegram': return value('token');
    case 'feishu': return `app_id: ${value('appId')}\napp_secret: ${value('appSecret')}`;
    case 'qq': return [`onebot: ${value('endpoint')}`, value('accessToken') === '' ? '' : `access_token: ${value('accessToken')}`].filter(Boolean).join('\n');
    case 'raw': return (values['text'] ?? '').trim();
  }
}

export const PASTE_FIELDS: Readonly<Record<PasteKind, readonly { key: string; secret: boolean; required: boolean }[]>> = {
  telegram: [{ key: 'token', secret: true, required: true }],
  feishu: [{ key: 'appId', secret: false, required: true }, { key: 'appSecret', secret: true, required: true }],
  qq: [{ key: 'endpoint', secret: false, required: true }, { key: 'accessToken', secret: true, required: false }],
  raw: [{ key: 'text', secret: false, required: true }],
};
