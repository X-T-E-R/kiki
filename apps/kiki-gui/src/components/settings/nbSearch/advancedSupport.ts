/**
 * Presentation helpers for the advanced nb-search editors.
 *
 * Everything that decides what a lane *is* — which instance it points at, which
 * operation it runs, whether a local override exists, which other entries
 * reference it — comes from `@kiki/session-core/settings`. These helpers only
 * turn those facts into the labels the page shows. No merging, no defaults:
 * when the server has not told us a value, the row says a value is missing
 * instead of inventing one.
 */

import type { FetchRouteRule, FetchRoutingCapability, NbSearchCapabilities, NbSearchConfigPatch } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { NbSearchDraft, NbSearchReferenceIssue } from '@kiki/session-core/settings';

import { providerLabelKey } from './types';

/** The routing domain the draft writes, in the exact shape the config carries. */
export type NbSearchRoutingDraft = NonNullable<NonNullable<NbSearchConfigPatch['fetch']>['routing']>;

/** Labels for the two dimensions every fetch chain is keyed by. */
export const FETCH_INPUT_KIND_KEYS: Readonly<Record<string, I18nKey>> = {
  url: 'st.nbSearch.fetch.input.url',
  inline_text: 'st.nbSearch.fetch.input.inlineText',
  inline_bytes: 'st.nbSearch.fetch.input.inlineBytes',
  file: 'st.nbSearch.fetch.input.file',
};

export const FETCH_REPRESENTATION_KEYS: Readonly<Record<string, I18nKey>> = {
  markdown: 'st.nbSearch.fetch.representation.markdown',
  text: 'st.nbSearch.fetch.representation.text',
};

export type NbSearchLaneConfig = NonNullable<NonNullable<NbSearchConfigPatch['lanes']>[string]>;
export type NbSearchPresetConfig = NonNullable<NonNullable<NbSearchConfigPatch['presets']>[string]>;

/**
 * What the three tabs need from the page: the one draft they all edit, the
 * saved config the reference validator compares against, and the one updater —
 * so every advanced edit lands in the same page-level draft and the same save.
 */
export interface NbSearchAdvancedBinding {
  readonly capabilities: NbSearchCapabilities;
  readonly draft: NbSearchDraft;
  readonly config: NbSearchConfigPatch | undefined;
  readonly onChange: (next: NbSearchDraft) => void;
}

/**
 * Where a search method or preset comes from.
 *
 * `source`: only the layer below Kiki declares it — the server's own config, the
 * environment, or the engine default. That layer is not necessarily the engine,
 * so the page says "source", never "built in".
 * `local`: only Kiki declares it; deleting it is the whole act.
 * `override`: both declare it, so Kiki's copy is an override that can be taken
 * back, revealing the source version again.
 * `localUnconfirmed`: Kiki declares it and the layer below was not reported this
 * session. The entry is a local setting — that part is a fact — but whether a
 * source version also exists is not, so nothing promises that removing the local
 * declaration makes the entry disappear.
 * `unknown`: nothing here declares it and the layer below was not reported
 * either, so where it comes from is unconfirmed. No delete to offer, no source
 * to restore.
 */
export type NbSearchItemSource = 'local' | 'source' | 'override' | 'localUnconfirmed' | 'unknown';

/**
 * Kiki's own declaration is the only thing that makes an item local, and
 * `capabilities.inherited_configuration` is the only thing that says a layer
 * below also declares it. `capabilities.search.lanes` / `presets` are the
 * *effective* catalog: a local item appears there too once it is saved, so they
 * must never be read as "the source has this".
 *
 * `providedBelow` is `undefined` when the projection is missing, which is not
 * the same as "no": a server may omit the lower layer when reading it failed, so
 * the source reading stays open instead of being invented. A local declaration
 * survives that either way, and its delete path stays available.
 */
export function nbSearchItemSource(declaredHere: boolean, providedBelow: boolean | undefined): NbSearchItemSource {
  if (providedBelow === undefined) return declaredHere ? 'localUnconfirmed' : 'unknown';
  if (!declaredHere) return 'source';
  return providedBelow ? 'override' : 'local';
}

/**
 * Which actions an item's origin actually supports. Removing a local
 * declaration is always a real act; handing the entry back to a layer below
 * needs evidence that a layer below has it, and renaming an override would give
 * the source version back and leave a plain local one behind.
 */
export interface NbSearchItemActions {
  readonly canRemoveLocal: boolean;
  readonly canRestoreSource: boolean;
  readonly canRename: boolean;
}

export function nbSearchItemActions(source: NbSearchItemSource): NbSearchItemActions {
  return {
    canRemoveLocal: source === 'local' || source === 'localUnconfirmed',
    canRestoreSource: source === 'override',
    canRename: source !== 'override',
  };
}

/** `undefined` when the server did not report the layer below at all. */
function providedBelow<T>(map: Readonly<Record<string, T>> | undefined, id: string): boolean | undefined {
  return map === undefined ? undefined : map[id] !== undefined;
}

export interface NbSearchLaneIdentity {
  /** The profile in force for this lane id, when any layer has one. */
  readonly profile?: NbSearchLaneConfig;
  readonly source: NbSearchItemSource;
}

export function nbSearchLaneIdentity(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  laneId: string,
): NbSearchLaneIdentity {
  const own = draft.advanced?.lanes[laneId] ?? undefined;
  return {
    profile: own
      ?? capabilities.configuration?.lanes[laneId]
      ?? capabilities.inherited_configuration?.lanes[laneId],
    source: nbSearchItemSource(own !== undefined, providedBelow(capabilities.inherited_configuration?.lanes, laneId)),
  };
}

export interface NbSearchPresetIdentity {
  readonly source: NbSearchItemSource;
}

export function nbSearchPresetIdentity(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  presetId: string,
): NbSearchPresetIdentity {
  const own = draft.advanced?.presets[presetId] ?? undefined;
  return {
    source: nbSearchItemSource(own !== undefined, providedBelow(capabilities.inherited_configuration?.presets, presetId)),
  };
}

/** The badge word for an item's source, shown next to its stable id. */
export function nbSearchSourceBadgeKey(source: NbSearchItemSource): I18nKey {
  if (source === 'localUnconfirmed') return 'st.nbSearch.custom.badgeLocalSetting';
  if (source === 'unknown') return 'st.nbSearch.custom.badgeOriginUnknown';
  return source === 'local' ? 'st.nbSearch.custom.badgeLocal' : 'st.nbSearch.custom.badgeSource';
}

export function nbSearchProviderLabel(t: (key: I18nKey) => string, providerId: string): string {
  const key = providerLabelKey(providerId);
  return key === undefined ? providerId : t(key);
}

export function nbSearchInstanceProviderId(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  instanceId: string,
): string | undefined {
  return draft.providers[instanceId]?.providerId
    ?? capabilities.providers.instances.find((instance) => instance.id === instanceId)?.provider_id;
}

/** Instances a lane may point at: the server's set minus drafted deletions, plus new drafts. */
export function nbSearchInstanceIds(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
): string[] {
  const ids = new Set(capabilities.providers.instances.map((instance) => instance.id));
  for (const [id, provider] of Object.entries(draft.providers)) {
    if (provider.isNew === true && provider.isDeleted !== true) ids.add(id);
  }
  return [...ids]
    .filter((id) => draft.providers[id]?.isDeleted !== true)
    .toSorted((left, right) => left.localeCompare(right));
}

export interface NbSearchOperation {
  readonly operationId: string;
  /** `results`, `typed`, or `fetch` for the provider's own fetch operations. */
  readonly channel: string;
}

export function nbSearchOperations(
  capabilities: NbSearchCapabilities,
  providerId: string | undefined,
): NbSearchOperation[] {
  const descriptor = capabilities.providers.descriptors.find(
    (candidate) => candidate.provider_id === providerId,
  );
  if (descriptor === undefined) return [];
  return [
    ...descriptor.query_operations.map((operation) => ({
      operationId: operation.operation_id,
      channel: operation.output.channel,
    })),
    ...descriptor.fetch_operations.map((operation) => ({
      operationId: operation.operation_id,
      channel: 'fetch',
    })),
  ].toSorted((left, right) => left.operationId.localeCompare(right.operationId));
}

/** Lane ids whose output channel is `results` — the only lanes a preset may list. */
export function nbSearchResultsLaneIds(capabilities: NbSearchCapabilities): string[] {
  return capabilities.search.lanes
    .filter((lane) => lane.output.channel === 'results')
    .map((lane) => lane.id)
    .toSorted((left, right) => left.localeCompare(right));
}

/** Preset names the engine itself serves, alongside whatever the user saved. */
export function nbSearchEnginePresetNames(capabilities: NbSearchCapabilities): string[] {
  return capabilities.search.presets.map((preset) => preset.name);
}

/**
 * What a row says about a lane or pipeline. Unavailability wins over the
 * execution mode: "sync ready" on a service that cannot run at all would be a
 * promise the row cannot keep. An empty mode list is unavailable, never
 * "async only" — that is the difference between a background-only method and
 * one that is not configured.
 */
export function nbSearchUsageWord(
  availability: 'ready' | 'unavailable' | undefined,
  executionKind: 'sync' | 'async-only' | 'none',
): I18nKey {
  if (availability !== 'ready' || executionKind === 'none') return 'st.nbSearch.lanes.unavailable';
  return executionKind === 'sync' ? 'st.nbSearch.lanes.syncSupported' : 'st.nbSearch.lanes.asyncOnly';
}

/**
 * What a broken reference means, said in the user's terms. The raw code and
 * path travel beside the sentence for diagnostics, never as the headline.
 */
export function nbSearchIssueText(
  t: (key: I18nKey, params?: Record<string, string>) => string,
  issue: NbSearchReferenceIssue,
): string {
  switch (issue.code) {
    case 'instance': return t('st.nbSearch.advanced.issue.instance', { target: issue.target });
    case 'operation': return t('st.nbSearch.advanced.issue.operation', { target: issue.target });
    case 'lane': return t('st.nbSearch.advanced.issue.lane', { target: issue.target });
    case 'preset-results': return t('st.nbSearch.advanced.issue.presetResults', { target: issue.target });
    case 'pipeline': return t('st.nbSearch.advanced.issue.pipeline', { target: issue.target });
    case 'pipeline-incompatible': return t('st.nbSearch.advanced.issue.pipelineIncompatible', { target: issue.target });
    default: return t('st.nbSearch.advanced.issue.unknown');
  }
}

/**
 * The entries a reference path names, in plain words: "the default search
 * method", "the preset Fast". Used before a deletion so the user sees what
 * would break, not an internal path.
 */
export function nbSearchReferenceSubject(
  t: (key: I18nKey, params?: Record<string, string>) => string,
  path: string,
): string {
  if (path === 'defaults.search_lane') return t('st.nbSearch.custom.reference.defaultLane');
  if (path.startsWith('presets.')) return t('st.nbSearch.custom.reference.preset', { id: path.slice('presets.'.length) });
  if (path.startsWith('lanes.')) return t('st.nbSearch.custom.reference.lane', { lane: path.slice('lanes.'.length) });
  if (path.startsWith('fetch.routing.rules.')) {
    return t('st.nbSearch.custom.reference.routeRule', { id: path.slice('fetch.routing.rules.'.length) });
  }
  const chain = /^defaults\.fetch_chain\.([^.]+)\.([^.]+)$/.exec(path);
  if (chain !== null) {
    const input = chain[1]!;
    const representation = chain[2]!;
    const inputKey = FETCH_INPUT_KIND_KEYS[input];
    const representationKey = FETCH_REPRESENTATION_KEYS[representation];
    return t('st.nbSearch.custom.reference.chain', {
      input: inputKey === undefined ? input : t(inputKey),
      representation: representationKey === undefined ? representation : t(representationKey),
    });
  }
  return path;
}

/**
 * Fetch routing, read the way the page has to read it.
 *
 * Three states again, and the page must not blur them: `undefined` writes
 * nothing and the source routing stays in force, a value is a Kiki-owned
 * routing config, and `null` explicitly clears the inherited one. The engine
 * treats "cleared" as "no user rules, built-in package still on" — the row says
 * that in words rather than as a dead toggle.
 *
 * Package metadata and coverage come from the server's routing projection.
 * The source projection supplies inherited fields when the draft removes or
 * partially overrides a saved declaration; the old effective projection must
 * not keep that declaration alive. A clear resets every routing field to the
 * selector's defaults. No URL matching happens here, and missing package
 * metadata remains explicitly unreported.
 */
export type NbSearchRoutingMode = 'inherited' | 'custom' | 'cleared';

export interface NbSearchRoutingView {
  readonly mode: NbSearchRoutingMode;
  /** `undefined` when the server reported no routing capability at all. */
  readonly reported: boolean;
  /** The server's effective view, or the package default when unreported. */
  readonly effective: FetchRoutingCapability;
}

export function nbSearchRoutingView(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
): NbSearchRoutingView {
  const own = draft.advanced?.routing;
  const reported = capabilities.fetch.routing;
  const base: FetchRoutingCapability = reported ?? {
    enabled: true,
    builtin_enabled: true,
    package: { id: '', version: '', maintainer: '', summary: '' },
    builtin_rules: [],
    disabled_builtin_rules: [],
    rules: [],
  };
  const inherited = capabilities.inherited_configuration;
  const source: FetchRoutingCapability = inherited === undefined ? base : {
    ...base,
    enabled: inherited.routing?.enabled !== false,
    builtin_enabled: inherited.routing?.builtin_enabled !== false,
    disabled_builtin_rules: [...inherited.routing?.disabled_builtin_rules ?? []],
    rules: [...inherited.routing?.rules ?? []],
  };
  if (own === undefined) return { mode: 'inherited', reported: reported !== undefined, effective: source };
  if (own === null) {
    // A clear is exactly "no rules from the source". The engine keeps its own
    // defaults for everything the clear does not speak about, so the built-in
    // package stays on rather than being switched off as a side effect.
    return {
      mode: 'cleared',
      reported: reported !== undefined,
      effective: { ...base, enabled: true, builtin_enabled: true, disabled_builtin_rules: [], rules: [] },
    };
  }
  return {
    mode: 'custom',
    reported: reported !== undefined,
    effective: {
      ...base,
      enabled: own.enabled ?? source.enabled,
      builtin_enabled: own.builtin_enabled ?? source.builtin_enabled,
      disabled_builtin_rules: [...own.disabled_builtin_rules ?? source.disabled_builtin_rules],
      rules: [...own.rules ?? source.rules],
    },
  };
}

/**
 * The user rules the page edits, in the order the engine tries them. The
 * standard config replaces the whole array, so this is always the complete
 * list Kiki would save, never a diff against a hidden baseline.
 */
export function nbSearchUserRules(view: NbSearchRoutingView): readonly FetchRouteRule[] {
  return view.effective.rules;
}

/** Whether a built-in rule is in force: routing and the package are on, and the id is not disabled. */
export function nbSearchBuiltinRuleActive(view: NbSearchRoutingView, ruleId: string): boolean {
  return view.effective.enabled && view.effective.builtin_enabled && !view.effective.disabled_builtin_rules.includes(ruleId);
}
