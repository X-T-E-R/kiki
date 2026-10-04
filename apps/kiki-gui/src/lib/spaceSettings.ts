/**
 * Space settings — the GUI side of the `rest.homes` detail / preview / apply
 * contract (spaces semantics design 2026-10-02). One contract serves three
 * surfaces: the space's own settings page, the row menu in the space list, and
 * the origin marks next to a setting that a space can follow or fix.
 *
 * Item identities are always the server's own (`pref:theme`,
 * `config:default_model`, `resource:skills:<name>`, `source:credentials`); this
 * module never mints its own DTO or guesses a signature. Values shown to people
 * go through `spaceValueLabel`, which keeps internal keys and revisions out of
 * the interface.
 */

import {
  SPACE_ID_PATTERN,
  type SpaceDetail,
  type SpaceDomain,
  type SpaceItem,
  type SpacePlanRequest,
  type SpacePreview,
} from '@kiki/protocol';
import type { I18nKey, I18nParams } from '@kiki/session-core/i18n';

import { useQuery } from '@tanstack/react-query';
import type { KikiClient } from './client';
import type { SpaceIdentity } from './spaceAuthority';
import { MAIN_SPACE_ID, homesApi } from './spaces';

export interface SpaceSettingsTarget {
  readonly client: KikiClient;
  readonly identity: SpaceIdentity;
}

export function spaceSettingsTargetOf(client: KikiClient, meta: { server_id: string; current_space_id?: string } | null | undefined): SpaceSettingsTarget | null {
  const homeId = meta?.current_space_id;
  if (!meta?.server_id || homeId === undefined || (homeId !== MAIN_SPACE_ID && !SPACE_ID_PATTERN.test(homeId))) return null;
  return { client, identity: { serverId: meta.server_id, homeId } };
}

const clientIds = new WeakMap<KikiClient, number>();
let nextClientId = 0;
export function spaceSettingsClientKey(client: KikiClient): number {
  let id = clientIds.get(client);
  if (id === undefined) { id = ++nextClientId; clientIds.set(client, id); }
  return id;
}

export function useSpaceSettingsTarget(client: KikiClient | null, knownMeta?: { server_id: string; current_space_id?: string } | null): SpaceSettingsTarget | null {
  const metadata = useQuery({
    queryKey: ['space-settings', 'meta', client === null ? null : spaceSettingsClientKey(client)],
    queryFn: async ({ signal }) => {
      if (client === null) throw new Error('Space client unavailable');
      const meta = await client.meta();
      signal.throwIfAborted();
      return meta;
    },
    enabled: client !== null && knownMeta === undefined,
    staleTime: 30_000,
    retry: false,
  });
  return client === null ? null : spaceSettingsTargetOf(client, knownMeta === undefined ? metadata.data : knownMeta);
}

export { MAIN_SPACE_ID };

/** The protocol exports the row schema but not its type; this is that type. */
export type SpacePreviewRow = SpacePreview['rows'][number];

type HomesRest = ReturnType<typeof homesApi>;

/** The five calls the space settings surfaces use. */
export type SpaceSettingsApi = Pick<HomesRest, 'detail' | 'preview' | 'apply' | 'undo' | 'importPreferences'>;

export function spaceSettingsApi(client: KikiClient): SpaceSettingsApi {
  return homesApi(client);
}

export type Translate = (key: I18nKey, params?: I18nParams) => string;

export const spaceSettingsKeys = {
  all: ['space-settings'] as const,
  detail: (id: string) => ['space-settings', 'detail', id] as const,
};

/**
 * Reading order of the space settings page (design §5.1): the settings people
 * change most first, the two source rows last. `generic_roots` is not in this
 * list — it is a property of the machine's shared folder, so it gets its own
 * "resource sources" line rather than a row among the inheritable domains.
 */
export const SPACE_GROUP_ORDER: readonly SpaceDomain[] = [
  'config', 'appearance', 'agents', 'instructions', 'skills', 'mcp', 'credentials', 'plugins',
];

/** The one row that answers "use this machine's shared folder or not". */
export const SPACE_RESOURCE_DOMAIN: SpaceDomain = 'generic_roots';

export function spaceGroupLabelKey(domain: SpaceDomain): I18nKey {
  return `st.spaces.group.${domain}`;
}

// ---------------------------------------------------------------------------
// The preference facts a space can carry, by their wire id.
// ---------------------------------------------------------------------------

export const SPACE_ITEM_IDS = {
  theme: 'pref:theme',
  skin: 'pref:skin',
  tweaks: 'pref:tweaks',
  background: 'pref:background',
  proseFont: 'pref:proseFont',
  defaultAppendTiming: 'pref:defaultAppendTiming',
  foldSteps: 'pref:foldSteps',
  worktreeSkipConfirm: 'pref:worktreeSkipConfirm',
} as const;

export type SpacePreferenceItem = keyof typeof SPACE_ITEM_IDS;

export function spaceItem(detail: SpaceDetail | undefined, id: string): SpaceItem | undefined {
  return detail?.items.find((item) => item.id === id);
}

function snakeSegment(segment: string): string {
  return segment.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The wire id of one `config.toml` setting, built the way the server builds it
 * from the file's own key path. The page hands in the domain and path the way
 * the config API speaks them (camel case leaves), the space detail speaks TOML
 * keys, so `['subagent', 'defaultModel']` is `config:subagent.default_model`.
 */
export function spaceConfigItemId(domain: string, keyPath: readonly string[] = []): string {
  return `config:${[domain, ...keyPath].map(snakeSegment).join('.')}`;
}

/**
 * Titles this interface already has, for the items it can name. A known item is
 * shown in the reader's language; every other id keeps the server's own name,
 * because for a resource, a model or a service that name is what the person
 * typed and must not be translated.
 */
const ITEM_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  'pref:theme': 'st.appearance.theme',
  'pref:skin': 'st.skin.title',
  'pref:tweaks': 'st.skin.tweaks',
  'pref:background': 'st.bg.title',
  'pref:proseFont': 'st.appearance.prose',
  'pref:defaultAppendTiming': 'st.communication.appendTimingTitle',
  'pref:foldSteps': 'st.transcript.foldSteps',
  'pref:worktreeSkipConfirm': 'st.composer.worktreeConfirm',
  'config:default_model': 'st.defaults.globalModelLabel',
  'config:fast_model': 'st.defaults.row.fast',
  'config:subagent.default_model': 'st.defaults.row.subagent',
  'config:session_title.model': 'st.defaults.row.title',
  'config:default_permission_mode': 'st.defaults.permissionMode',
  'config:default_plan_mode': 'st.defaults.planMode',
  'config:thinking.effort': 'st.profiles.effort',
  'source:credentials': 'st.spaces.group.credentials',
  'source:instructions': 'st.spaces.group.instructions',
  'source:generic_roots': 'st.spaces.group.generic_roots',
};

export function spaceItemLabel(id: string, name: string, t: Translate): string {
  const key = ITEM_LABEL_KEYS[id];
  return key === undefined ? name : t(key);
}

// ---------------------------------------------------------------------------
// Group summaries — real mode and counts, never a guess from equal values.
// ---------------------------------------------------------------------------

export interface SpaceGroupSummary {
  readonly mode: 'follow' | 'fixed';
  readonly fixedCount: number;
  readonly followCount: number;
  /** Instructions only: the main file is kept and this space adds its own. */
  readonly stacked: boolean;
}

export function spaceGroupSummary(detail: SpaceDetail, domain: SpaceDomain): SpaceGroupSummary | undefined {
  const group = detail.groups.find((entry) => entry.domain === domain);
  if (group === undefined) return undefined;
  return {
    mode: group.mode,
    fixedCount: group.fixed_count,
    followCount: group.follow_count,
    stacked: domain === 'instructions' && detail.inherit.instructions === 'stack',
  };
}

/**
 * One line per group. The main space has no parent to follow, so it reports
 * what it holds rather than labelling itself "follows the main space".
 */
export function spaceGroupSummaryText(detail: SpaceDetail, domain: SpaceDomain, t: Translate): string {
  const summary = spaceGroupSummary(detail, domain);
  if (summary === undefined) return t('st.spaces.origin.unknown');
  if (domain === 'credentials') return t(detail.inherit.credentials === 'shared' ? 'st.spaces.group.shared' : 'st.spaces.group.isolated');
  if (domain === SPACE_RESOURCE_DOMAIN) return t(detail.inherit.generic_roots ? 'st.spaces.group.available' : 'st.spaces.group.unavailable');
  if (detail.primary) return t('st.spaces.group.items', { count: summary.fixedCount });
  if (summary.mode === 'follow') {
    if (summary.stacked) return t('st.spaces.group.stacked');
    return summary.fixedCount === 0
      ? t('st.spaces.group.follow')
      : t('st.spaces.group.followFixed', { count: summary.fixedCount });
  }
  return summary.followCount === 0
    ? t('st.spaces.group.fixed')
    : t('st.spaces.group.fixedFollow', { count: summary.followCount });
}

// ---------------------------------------------------------------------------
// "What this space set" — the entries it really holds, not a copy of main's.
// ---------------------------------------------------------------------------

export function spaceOwnChoices(detail: SpaceDetail): SpaceItem[] {
  const rank = new Map<SpaceDomain, number>([...SPACE_GROUP_ORDER, SPACE_RESOURCE_DOMAIN].map((domain, index) => [domain, index]));
  return detail.items
    .filter((item) => item.kind !== 'source' && item.origin === 'home')
    .toSorted((left, right) => (rank.get(left.domain) ?? 99) - (rank.get(right.domain) ?? 99) || left.name.localeCompare(right.name));
}

/** Edited here (a person changed it) vs fixed here (frozen or migrated). */
export function spaceOwnChoiceLabelKey(item: SpaceItem): I18nKey {
  return item.selection.reason === 'edited' ? 'st.spaces.ownChoice.edited' : 'st.spaces.ownChoice.fixed';
}

/**
 * Where an item is edited in full. Only the places this GUI can name are
 * linked; anything else shows its name and value without pretending there is
 * a page for it.
 */
const ITEM_ROUTES: Readonly<Record<string, string>> = {
  'pref:theme': '/settings/appearance',
  'pref:skin': '/settings/appearance',
  'pref:tweaks': '/settings/appearance',
  'pref:background': '/settings/appearance',
  'pref:proseFont': '/settings/appearance',
  'pref:defaultAppendTiming': '/settings/general',
  'pref:foldSteps': '/settings/general',
  'pref:worktreeSkipConfirm': '/settings/general',
  'config:default_model': '/settings/ai',
  'config:fast_model': '/settings/ai',
  'config:thinking.effort': '/settings/ai',
  'config:session_title.model': '/settings/ai',
  'config:default_permission_mode': '/settings/permissions',
};

const ITEM_ROUTE_PREFIXES: readonly (readonly [string, string])[] = [
  ['resource:agents:', '/settings/agents'],
  ['resource:skills:', '/settings/skills'],
  ['resource:mcp:', '/settings/mcp'],
  ['resource:plugins:', '/settings/plugins'],
  ['resource:appearance:', '/settings/appearance'],
];

export function spaceItemRoute(id: string): string | undefined {
  const exact = ITEM_ROUTES[id];
  if (exact !== undefined) return exact;
  return ITEM_ROUTE_PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1];
}

// ---------------------------------------------------------------------------
// Values, in the words a person used to choose them.
// ---------------------------------------------------------------------------

function shortText(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function compactJson(value: unknown): string {
  try {
    return shortText(JSON.stringify(value), 72);
  } catch {
    return '';
  }
}

function preferenceValueLabel(id: string, value: unknown, t: Translate): string | undefined {
  if (id === 'pref:background' && (value === null || value === undefined)) return t('st.spaces.value.backgroundNone');
  if (id === 'pref:theme' && (value === 'light' || value === 'dark' || value === 'system')) return t(`st.appearance.theme.${value}` as I18nKey);
  if (id === 'pref:proseFont' && (value === 'serif' || value === 'sans')) return t(`st.appearance.prose.${value}` as I18nKey);
  if (id === 'pref:defaultAppendTiming' && (value === 'agent_idle' || value === 'subagents_done' || value === 'tasks_done')) {
    return t(`st.spaces.value.appendTiming.${value}` as I18nKey);
  }
  if (id === 'pref:skin' && typeof value === 'object' && value !== null) {
    const selection = value as { source?: unknown; id?: unknown };
    if (typeof selection.id !== 'string') return undefined;
    const source = selection.source === 'pack' ? 'st.spaces.value.skinPack' : selection.source === 'user' ? 'st.spaces.value.skinUser' : 'st.spaces.value.skinBuiltin';
    return t(source, { id: selection.id });
  }
  if (id === 'pref:tweaks' && typeof value === 'object' && value !== null) {
    const count = Object.keys(value).length;
    return count === 0 ? t('st.spaces.value.tweaksNone') : t('st.spaces.value.tweaksCount', { count });
  }
  if (id === 'pref:background' && typeof value === 'object' && value !== null) {
    const background = value as { light?: unknown; dark?: unknown; linked?: unknown };
    const slot = (background.linked === false ? background.dark : background.light) ?? background.light ?? background.dark;
    if (slot === null || slot === undefined || typeof slot !== 'object') return t('st.spaces.value.backgroundNone');
    const media = (slot as { media?: unknown }).media;
    if (!Array.isArray(media) || media.length === 0) return t('st.spaces.value.backgroundNone');
    if (media.length > 1) return t('st.spaces.value.backgroundCount', { count: media.length });
    const first = media[0] as { name?: unknown; id?: unknown };
    const name = typeof first?.name === 'string' && first.name !== '' ? first.name : typeof first?.id === 'string' ? first.id.split('/').at(-1) ?? first.id : '';
    return name === '' ? t('st.spaces.value.backgroundCount', { count: media.length }) : shortText(name, 32);
  }
  return undefined;
}

/** A short, human label for any item value. Never shows a revision or a path. */
export function spaceValueLabel(id: string, value: unknown, t: Translate): string {
  const preference = preferenceValueLabel(id, value, t);
  if (preference !== undefined) return preference;
  if (value === null || value === undefined) return t('st.spaces.value.none');
  if (typeof value === 'boolean') return t(value ? 'st.spaces.value.on' : 'st.spaces.value.off');
  if (typeof value === 'string') return shortText(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return t('st.spaces.group.items', { count: value.length });
  return compactJson(value);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface SpacePreviewSections {
  /** Rows whose value or mode differs from what the plan would write. */
  readonly changed: readonly SpacePreviewRow[];
  /** Rows that already hold the target value; the mode may still change. */
  readonly same: readonly SpacePreviewRow[];
  /** The `group:<domain>` rows: which default future main-space items get. */
  readonly groups: readonly SpacePreviewRow[];
}

export function spacePreviewSections(preview: SpacePreview): SpacePreviewSections {
  const groups: SpacePreviewRow[] = [];
  const changed: SpacePreviewRow[] = [];
  const same: SpacePreviewRow[] = [];
  for (const row of preview.rows) {
    if (row.id.startsWith('group:')) groups.push(row);
    else if (row.same_value) same.push(row);
    else changed.push(row);
  }
  return { changed, same, groups };
}

export function spacePreviewSelectable(row: SpacePreviewRow): boolean {
  return row.blocked_reason === undefined;
}

/** The reason a row cannot change, in the interface's own words when known. */
const BLOCKED_REASONS: readonly (readonly [string, I18nKey])[] = [
  ['Resource content is unavailable', 'st.spaces.blocked.resourceUnavailable'],
  ['Only resources can be excluded', 'st.spaces.blocked.onlyResources'],
  ['This item cannot be shared through the ordinary push flow', 'st.spaces.blocked.notShareable'],
  ['Edit this resource through its resource editor', 'st.spaces.blocked.editResource'],
  ['Main space has no parent source', 'st.spaces.blocked.mainNoParent'],
];

export function spaceBlockedReasonText(reason: string, t: Translate): string {
  if (reason.startsWith('Connection contains account data')) return t('st.spaces.blocked.accountData');
  const known = BLOCKED_REASONS.find(([text]) => text === reason);
  return known === undefined ? reason : t(known[1]);
}

export function spacePlan(action: SpacePlanRequest['action'], fields: Omit<SpacePlanRequest, 'action'> = {}): SpacePlanRequest {
  return { action, ...fields };
}
