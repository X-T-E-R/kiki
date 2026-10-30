/**
 * Pure helpers for two-way chat accounts: display names, the one state an
 * account row leads with, identity labels and target values. No React here.
 */

import {
  builtinImProviderKindSchema,
  type ImBinding,
  type ImCatalog,
  type ImConfirmRequest,
  type ImIdentity,
  type ImProviderKind,
  type ImSessionSnapshot,
  type ImSetupCatalog,
  type ImSetupProvider,
} from '@kiki/protocol';
import { translate, type I18nKey } from '@kiki/session-core/i18n';

import type { useI18n } from '../../../i18n';
import { BRAND_KEY, brandOfIm, type BrandId } from './catalog';

export const IM_KEY = ['im-sessions'] as const;
export type ImInstanceStatus = ImSessionSnapshot['instances'][number];
export type Translator = ReturnType<typeof useI18n>['t'];
export type SetupPlatformEntry = ImSetupCatalog['platforms'][number];

export const SETUP_FIELD_KEYS: Readonly<Record<string, I18nKey>> = {
  bot_token: 'st.im.setup.field.bot_token',
  app_token: 'st.im.setup.field.app_token',
  homeserver: 'st.im.setup.field.homeserver',
  access_token: 'st.im.setup.field.access_token',
};

export const MEDIA_KIND_KEYS: Readonly<Record<string, I18nKey>> = {
  image: 'message.media.image',
  file: 'message.media.file',
  audio: 'message.media.audio',
  voice: 'message.media.voice',
  video: 'message.media.video',
};

export function isSetupProvider(kind: string | undefined): kind is ImSetupProvider {
  return kind === 'discord' || kind === 'slack' || kind === 'matrix';
}

export function identityLabel(identity: ImIdentity, t: Translator): string {
  return [identity.chat_title ?? identity.sender_name ?? identity.chat_id,
    identity.chat_title !== undefined ? identity.sender_name : undefined,
    identity.topic_id !== '0' ? identity.topic_title ?? `${t('st.im.topicId')} ${identity.topic_id}` : undefined].filter(Boolean).join(' · ');
}

export function parseTarget(value: string): ImConfirmRequest['target'] {
  return value.startsWith('persona:') ? { kind: 'persona', persona_id: value.slice(8) } : { kind: 'session', session_id: value.slice(8) };
}

export function bindingTargetValue(binding: ImBinding): string {
  return binding.pending_reanchor
    ? 'unassigned'
    : binding.persona_id !== undefined
      ? `persona:${binding.persona_id}`
      : binding.session_id !== undefined
        ? `session:${binding.session_id}`
        : 'unassigned';
}

/**
 * The thread a binding lands on, as a short name for the row's facts line.
 * Personas keep their name, sessions their title; an unassigned or
 * re-anchoring binding says so in words, never as a raw id.
 */
export function bindingTargetName(catalog: ImCatalog | undefined, binding: ImBinding, t: Translator): string {
  if (binding.pending_reanchor) return t('st.im.pendingReanchor');
  if (binding.persona_id !== undefined) {
    const name = catalog?.personas.find((item) => item.id === binding.persona_id)?.name;
    return name === undefined ? binding.persona_id : `${t('st.im.kindPersona')} · ${name}`;
  }
  if (binding.session_id !== undefined) {
    const title = catalog?.sessions.find((item) => item.id === binding.session_id)?.title;
    return title === undefined ? binding.session_id : `${t('st.im.kindSession')} · ${title}`;
  }
  return t('st.im.pendingReanchor');
}

export function bindingTargetChoices(catalog: ImCatalog | undefined, binding: ImBinding, t: Translator): { value: string; label: string }[] {
  const choices = [
    ...(catalog?.personas ?? []).map((item) => ({ value: `persona:${item.id}`, label: `${t('st.im.kindPersona')} · ${item.name}` })),
    ...(catalog?.sessions ?? []).map((item) => ({ value: `session:${item.id}`, label: `${t('st.im.kindSession')} · ${item.title}` })),
  ];
  const current = bindingTargetValue(binding);
  const fallbackLabel = binding.pending_reanchor
    ? t('st.im.pendingReanchor')
    : binding.persona_id ?? binding.session_id ?? t('st.im.pendingReanchor');
  if (!choices.some((choice) => choice.value === current)) choices.unshift({ value: current, label: fallbackLabel });
  return choices;
}

export function providerDisplayName(kind: ImProviderKind, t: Translator): string {
  const builtin = builtinImProviderKindSchema.safeParse(kind);
  return builtin.success ? t(`st.im.provider.${builtin.data}`) : kind;
}

/**
 * The account's own name. A missing label, or one that only repeats the
 * platform in either language ("WeChat", "微信", the provider kind), falls
 * back to the platform's one localized name, the same one the add grid uses.
 */
export function instanceDisplayName(item: ImInstanceStatus, t: Translator): string {
  const brand = brandOfIm(item.provider_kind);
  const platform = brand === 'plugin' ? providerDisplayName(item.provider_kind, t) : t(BRAND_KEY[brand]);
  const label = item.label?.trim() ?? '';
  if (label === '' || genericNames(item.provider_kind, brand).has(label.toLowerCase())) return platform;
  return label;
}

function genericNames(kind: ImProviderKind, brand: BrandId): Set<string> {
  const names = new Set([kind.toLowerCase()]);
  const builtin = builtinImProviderKindSchema.safeParse(kind);
  for (const locale of ['en', 'zh'] as const) {
    if (brand !== 'plugin') names.add(translate(locale, BRAND_KEY[brand]).toLowerCase());
    if (builtin.success) names.add(translate(locale, `st.im.provider.${builtin.data}`).toLowerCase());
  }
  return names;
}

export type ImAccountState = 'listening' | 'starting' | 'reconnecting' | 'auth_expired' | 'stopped' | 'paused';

/**
 * The one state an account row leads with. `paused` is the person's own
 * choice (not listening); `stopped` is a listener that should run but does not.
 */
export function instanceState(item: ImInstanceStatus): ImAccountState {
  const connection: string | undefined = item.connection;
  if (connection === 'auth_expired') return 'auth_expired';
  if (!item.listening) return 'paused';
  if (connection === 'starting') return 'starting';
  if (connection === 'reconnecting') return 'reconnecting';
  if (connection === 'stopped' || item.adapter === 'stopped' || item.adapter === 'missing') return 'stopped';
  return 'listening';
}

export const IM_STATE_KEY: Readonly<Record<ImAccountState, I18nKey>> = {
  listening: 'st.im.stateListening',
  starting: 'st.im.stateStarting',
  reconnecting: 'st.im.stateReconnecting',
  auth_expired: 'st.im.stateAuthExpired',
  stopped: 'st.im.stateListenerStopped',
  paused: 'st.channels.state.paused',
};

/** Something on the account asks the person to act. */
export function instanceNeedsAttention(item: ImInstanceStatus, discoveries: number): boolean {
  const state = instanceState(item);
  return discoveries > 0 || state === 'auth_expired' || state === 'stopped' || (item.inbound_diagnostics?.length ?? 0) > 0 || item.conflict !== undefined;
}

export function liveText(kind: ImProviderKind, setupPlatform?: SetupPlatformEntry): boolean {
  if (setupPlatform !== undefined) return setupPlatform.capabilities.edit_text;
  return kind === 'telegram' || kind === 'feishu_app' || kind === 'discord' || kind === 'slack' || kind === 'matrix';
}

export function wechatStatusKey(status: string): I18nKey {
  if (status === 'wait') return 'st.im.wechatWaiting';
  if (status === 'scaned' || status === 'scaned_but_redirect') return 'st.im.wechatScanned';
  if (status === 'expired') return 'st.im.wechatExpired';
  if (status === 'need_verifycode') return 'st.im.wechatVerify';
  if (status === 'verify_code_blocked') return 'st.im.wechatBlocked';
  if (status === 'binded_redirect') return 'st.im.wechatBound';
  if (status === 'cancelled') return 'st.im.wechatCancel';
  return 'st.im.error';
}

export function defaultTarget(catalog: ImCatalog | undefined): string {
  return catalog?.personas[0] !== undefined ? `persona:${catalog.personas[0].id}` : catalog?.sessions[0] !== undefined ? `session:${catalog.sessions[0].id}` : '';
}

/** Deep links may preselect a binding target with `?target=persona:<id>` or `session:<id>`. */
export function requestedTarget(): string {
  const value = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('target') ?? '';
  return /^(persona|session):.+/u.test(value) ? value : '';
}
