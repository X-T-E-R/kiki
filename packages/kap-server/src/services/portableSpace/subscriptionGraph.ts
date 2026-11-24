import { createHash } from 'node:crypto';
import {
  parseAgentFileText,
  parseAgentRouteFileText,
  parseFrontmatter,
  parsePersonaFileText,
  recipeManifestSchema,
  updateFrontmatterField,
  type AgentFileDefinition,
  type UnboundModelHoldEntry,
  type UnboundModelHoldTargetKind,
} from '@kiki/agent-core-v2';
import { nbSearchManagedCredentialsSchema } from '@kiki/agent-core-v2/app/nbSearch/managedCredentials';
import {
  formatBindingSlotTupleKey,
  PORTABLE_SPACE_MAX_PREVIEW_EDGES,
  PORTABLE_SPACE_MAX_PREVIEW_ITEMS,
  type PortableSpaceBindingChoices,
  type PortableSpaceBindingSlot,
  type PortableSpaceDependencyEdge,
  type PortableSpaceExcludedItem,
  type PortableSpaceLocalModelOption,
} from '@kiki/protocol';
import { portableValidationError } from './subscriptionErrors';
import {
  encodeUnitId,
  encodeUnitSegment,
  groupUnitsIntoSelectableEntities,
  type SelectableEntity,
} from './subscriptionScopes';
import { object, parseToml, type Data, type SpaceUnit, type Units } from './treeProjection';

const SPECIAL_MODEL_ALIASES = new Set(['inherit', 'auto']);

export interface ParsedEntityMetadata {
  readonly entity: SelectableEntity;
  readonly dependencyEdges: PortableSpaceDependencyEdge[];
  readonly softDependsOnIds: string[];
  readonly hardDependsOnIds: string[];
  readonly blockedDependencyIds: string[];
  readonly blockedReason?: string;
  readonly warnings: string[];
  readonly coupledCredentialIds: string[];
  readonly slots: PortableSpaceBindingSlot[];
}

export interface SubscriptionDependencyGraph {
  readonly entities: readonly SelectableEntity[];
  readonly entityById: ReadonlyMap<string, SelectableEntity>;
  readonly entityIdByMemberUnitId: ReadonlyMap<string, string>;
  readonly metadataByEntityId: ReadonlyMap<string, ParsedEntityMetadata>;
  readonly referencedByIds: ReadonlyMap<string, readonly string[]>;
  readonly consumerItemIdsByCredential: ReadonlyMap<string, readonly string[]>;
  readonly bindingSlots: readonly PortableSpaceBindingSlot[];
  readonly localModelOptions: readonly PortableSpaceLocalModelOption[];
  readonly catalogRevision: string;
  readonly excluded: readonly PortableSpaceExcludedItem[];
  readonly totalEdgeCount: number;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractPromptOverrideFiles(raw: unknown): string[] {
  const result = new Set<string>();
  const collect = (node: unknown) => {
    const rec = object(node);
    if (Array.isArray(rec['files'])) {
      for (const entry of rec['files']) {
        const file = asNonEmptyString(entry);
        if (file !== undefined) result.add(file.replaceAll('\\', '/'));
      }
    }
    for (const branch of ['common', 'main', 'independent']) {
      if (rec[branch] !== undefined) collect(rec[branch]);
    }
  };
  collect(raw);
  return [...result];
}

function extractRecipeRef(rawRecipe: unknown): string | undefined {
  if (typeof rawRecipe === 'string') return asNonEmptyString(rawRecipe);
  const rec = object(rawRecipe);
  return asNonEmptyString(rec['source']) ?? asNonEmptyString(rec['id']) ?? asNonEmptyString(rec['path']);
}

function resolveRecipeTargetEntityId(
  ref: string,
  packEntities: ReadonlyMap<string, SelectableEntity>,
  targetUnits: Units,
): { readonly toId?: string; readonly liveSatisfied: boolean } {
  const normalized = ref.replaceAll('\\', '/').replace(/^\.\//u, '');
  const candidates: string[] = [];
  if (normalized.startsWith('recipes/')) {
    candidates.push(encodeUnitId('recipes', [normalized]));
    if (!normalized.endsWith('.toml')) {
      candidates.push(encodeUnitId('recipes', [`${normalized}/recipe.toml`]));
      candidates.push(encodeUnitId('recipes', [`${normalized}.toml`]));
    }
  } else {
    candidates.push(encodeUnitId('recipes', ['installation', normalized]));
    candidates.push(encodeUnitId('recipes', [`recipes/${normalized}/recipe.toml`]));
    candidates.push(encodeUnitId('recipes', [`recipes/${normalized}.toml`]));
  }
  for (const id of candidates) {
    if (packEntities.has(id)) {
      return { toId: id, liveSatisfied: targetUnits.has(id) };
    }
  }
  for (const id of candidates) {
    if (targetUnits.has(id)) {
      return { toId: id, liveSatisfied: true };
    }
  }
  return { toId: candidates[0], liveSatisfied: false };
}

function resolvePromptTargetId(
  ref: string,
  packUnits: Units,
  targetUnits: Units,
): { readonly toId: string; readonly liveSatisfied: boolean } {
  const normalized = ref.replaceAll('\\', '/').replace(/^\.\//u, '');
  const id = encodeUnitId('instructions', [normalized]);
  return {
    toId: id,
    liveSatisfied: targetUnits.has(id) || (!packUnits.has(id) && targetUnits.has(encodeUnitId('instructions', [`prompts/${normalized}`]))),
  };
}

/** Builds the redacted local model catalog options and stable catalog revision from target space units. */
export function buildLocalModelCatalog(targetUnits: Units): {
  readonly options: PortableSpaceLocalModelOption[];
  readonly optionIndexById: Map<string, number>;
  readonly catalogRevision: string;
} {
  const options: PortableSpaceLocalModelOption[] = [];
  for (const unit of targetUnits.values()) {
    if (unit.domain !== 'config' || unit.key[0] !== 'models' || unit.key[1] === undefined) continue;
    const id = unit.key[1];
    const cfg = object(unit.value);
    const providerId = asNonEmptyString(cfg['provider']) ?? asNonEmptyString(cfg['provider_id']);
    const label = asNonEmptyString(cfg['display_name']) ?? asNonEmptyString(cfg['name']) ?? id;
    const rawEfforts = cfg['support_efforts'] ?? cfg['supported_efforts'] ?? cfg['thinking_efforts'];
    const thinkingEfforts = Array.isArray(rawEfforts)
      ? rawEfforts.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 32)
      : undefined;
    const defaultThinkingEffort = asNonEmptyString(cfg['default_thinking_effort']) ?? asNonEmptyString(cfg['thinking_effort']);
    const rawCaps = cfg['capabilities'];
    const capabilities = Array.isArray(rawCaps)
      ? rawCaps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 32)
      : undefined;
    options.push({
      id,
      label: label.slice(0, 256),
      ...(providerId !== undefined ? { providerId: providerId.slice(0, 128) } : {}),
      ...(thinkingEfforts !== undefined && thinkingEfforts.length > 0 ? { thinkingEfforts } : {}),
      ...(defaultThinkingEffort !== undefined ? { defaultThinkingEffort: defaultThinkingEffort.slice(0, 64) } : {}),
      ...(capabilities !== undefined && capabilities.length > 0 ? { capabilities } : {}),
    });
  }
  options.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const optionIndexById = new Map<string, number>();
  options.forEach((opt, idx) => optionIndexById.set(opt.id, idx));
  const catalogRevision = createHash('sha256').update(JSON.stringify(options)).digest('hex');
  return { options, optionIndexById, catalogRevision };
}

function computeEligibleOptionIndices(
  localOptions: readonly PortableSpaceLocalModelOption[],
  constraints?: {
    readonly allowedModels?: readonly string[];
    readonly denyModels?: readonly string[];
    readonly allowedEfforts?: readonly string[];
  },
): { readonly indices: number[]; readonly restrictionNote?: string } {
  const allowedSet = constraints?.allowedModels && constraints.allowedModels.length > 0
    ? new Set(constraints.allowedModels)
    : undefined;
  const denySet = constraints?.denyModels && constraints.denyModels.length > 0
    ? new Set(constraints.denyModels)
    : undefined;
  const allowedEffortsSet = constraints?.allowedEfforts && constraints.allowedEfforts.length > 0
    ? new Set(constraints.allowedEfforts.map((effort) => effort.toLowerCase()))
    : undefined;
  const indices: number[] = [];
  for (let i = 0; i < localOptions.length; i += 1) {
    const option = localOptions[i]!;
    if (denySet?.has(option.id)) continue;
    if (allowedSet !== undefined && !allowedSet.has(option.id)) continue;
    if (
      allowedEffortsSet !== undefined
      && option.thinkingEfforts !== undefined
      && option.thinkingEfforts.length > 0
      && !option.thinkingEfforts.some((effort) => allowedEffortsSet.has(effort.toLowerCase()))
    ) {
      continue;
    }
    indices.push(i);
  }
  let restrictionNote: string | undefined;
  if (indices.length === 0 && (allowedSet !== undefined || denySet !== undefined || allowedEffortsSet !== undefined)) {
    const notes: string[] = [];
    if (allowedSet !== undefined) notes.push(`allowed_models: ${[...allowedSet].join(', ')}`);
    if (denySet !== undefined) notes.push(`deny_models: ${[...denySet].join(', ')}`);
    if (allowedEffortsSet !== undefined) notes.push(`allowed_efforts: ${[...allowedEffortsSet].join(', ')}`);
    restrictionNote = `Restricted by profile constraints (${notes.join('; ')})`;
  }
  return { indices, restrictionNote };
}

function addEdge(
  edges: PortableSpaceDependencyEdge[],
  edge: PortableSpaceDependencyEdge,
): void {
  const existing = edges.find((entry) => entry.toId === edge.toId && entry.kind === edge.kind && entry.via === edge.via);
  if (existing === undefined) edges.push(edge);
}

function collectAgentProfileSlots(
  entity: SelectableEntity,
  parsed: AgentFileDefinition,
  packUnits: Units,
  localOptions: readonly PortableSpaceLocalModelOption[],
  optionIndexById: ReadonlyMap<string, number>,
  edges: PortableSpaceDependencyEdge[],
  slots: PortableSpaceBindingSlot[],
): void {
  if (parsed.endpoint !== undefined) return;
  if (parsed.executor !== undefined && parsed.executor !== 'native') return;
  const denySet = new Set(parsed.denyModels ?? []);
  const { indices, restrictionNote } = computeEligibleOptionIndices(localOptions, {
    allowedModels: parsed.allowedModels,
    denyModels: parsed.denyModels,
    allowedEfforts: parsed.allowedEfforts,
  });

  const seenAliases = new Set<string>();
  const registerModelRef = (alias: string | undefined, required: boolean, location: string) => {
    if (alias === undefined || SPECIAL_MODEL_ALIASES.has(alias) || denySet.has(alias)) return;
    const modelUnitId = encodeUnitId('config', ['models', alias]);
    const liveSatisfied = optionIndexById.has(alias);
    if (packUnits.has(modelUnitId) || liveSatisfied) {
      addEdge(edges, { toId: modelUnitId, kind: 'soft', via: location, liveSatisfied });
    }
    if (seenAliases.has(alias)) return;
    seenAliases.add(alias);
    slots.push({
      tupleKey: formatBindingSlotTupleKey(entity.id, alias),
      itemId: entity.id,
      itemLabel: entity.label,
      itemScope: entity.scope,
      sourceModelId: alias,
      required,
      location,
      eligibleOptionIndices: indices,
      ...(liveSatisfied ? { currentLocalModelId: alias } : {}),
      ...(restrictionNote !== undefined ? { restrictionNote } : {}),
    });
  };

  registerModelRef(parsed.modelAlias, true, 'model_alias');
  for (const mp of parsed.modelProfiles ?? []) {
    registerModelRef(mp.alias, false, 'model_profiles');
  }
  for (const pref of parsed.preferredModels ?? []) {
    if (SPECIAL_MODEL_ALIASES.has(pref) || denySet.has(pref)) continue;
    const modelUnitId = encodeUnitId('config', ['models', pref]);
    if (packUnits.has(modelUnitId)) {
      addEdge(edges, { toId: modelUnitId, kind: 'soft', via: 'preferred_models', liveSatisfied: optionIndexById.has(pref) });
    }
  }
}

function buildCredentialConsumerGraph(
  packUnits: Units,
  targetUnits: Units,
  entityIdByMemberUnitId: ReadonlyMap<string, string>,
  excluded: PortableSpaceExcludedItem[],
): {
  readonly consumerItemIdsByCredential: Map<string, string[]>;
  readonly coupledCredentialsByEntityId: Map<string, string[]>;
} {
  const consumerItemIdsByCredential = new Map<string, string[]>();
  const coupledCredentialsByEntityId = new Map<string, string[]>();

  const link = (credId: string, entityId: string) => {
    let consumers = consumerItemIdsByCredential.get(credId);
    if (consumers === undefined) {
      consumers = [];
      consumerItemIdsByCredential.set(credId, consumers);
    }
    if (!consumers.includes(entityId)) consumers.push(entityId);
    let creds = coupledCredentialsByEntityId.get(entityId);
    if (creds === undefined) {
      creds = [];
      coupledCredentialsByEntityId.set(entityId, creds);
    }
    if (!creds.includes(credId)) creds.push(credId);
  };

  const poolConsumers = new Map<string, Set<string>>();
  const addPoolConsumer = (credKey: string, entityId: string) => {
    let set = poolConsumers.get(credKey);
    if (set === undefined) {
      set = new Set();
      poolConsumers.set(credKey, set);
    }
    set.add(entityId);
  };

  for (const [id, unit] of packUnits) {
    const entityId = entityIdByMemberUnitId.get(id);
    if (entityId === undefined) continue;
    if (unit.domain === 'config' && unit.key[0] === 'providers' && unit.key[1] !== undefined) {
      const providerId = unit.key[1];
      const rec = object(unit.value);
      const explicitCredId = asNonEmptyString(rec['credential_id']);
      addPoolConsumer(providerId, entityId);
      if (explicitCredId !== undefined) addPoolConsumer(explicitCredId, entityId);
    } else if (unit.domain === 'config' && unit.key[0] === 'models' && unit.key[1] !== undefined) {
      const rec = object(unit.value);
      const explicitCredId = asNonEmptyString(rec['credential_id']);
      if (explicitCredId !== undefined) addPoolConsumer(explicitCredId, entityId);
    } else if (unit.domain === 'config' && unit.key[0] === 'nb_search') {
      const nb = object(unit.value);
      const providers = object(nb['providers']);
      for (const entry of Object.values(providers)) {
        const providerRec = object(entry);
        const conn = asNonEmptyString(providerRec['connection']) ?? asNonEmptyString(providerRec['provider_id']);
        if (conn !== undefined) addPoolConsumer(conn, entityId);
      }
    }
  }

  const nbSearchEntityId = entityIdByMemberUnitId.get('config:nb_search');
  const liveHasNbSearch = targetUnits.has('config:nb_search');

  for (const [credId, unit] of packUnits) {
    if (unit.domain !== 'credentials') continue;
    const section = unit.key[0];
    const key = unit.key[1];
    if (section === 'providers' && key !== undefined) {
      const providerEntityId = entityIdByMemberUnitId.get(encodeUnitId('config', ['providers', key]));
      if (providerEntityId !== undefined) link(credId, providerEntityId);
      else {
        excluded.push({
          id: credId,
          domain: 'credentials',
          path: unit.path,
          reason: `Orphan provider credential "${key}" has no declared provider in pack`,
        });
      }
    } else if (section === 'mcp' && key !== undefined) {
      const mcpEntityId = entityIdByMemberUnitId.get(encodeUnitId('mcp', [key]));
      if (mcpEntityId !== undefined) link(credId, mcpEntityId);
      else {
        excluded.push({
          id: credId,
          domain: 'credentials',
          path: unit.path,
          reason: `Orphan MCP credential "${key}" has no admitted MCP server in pack`,
        });
      }
    } else if (section === 'pool' && key !== undefined) {
      const consumers = poolConsumers.get(key);
      if (consumers !== undefined && consumers.size > 0) {
        for (const entityId of consumers) link(credId, entityId);
      } else {
        excluded.push({
          id: credId,
          domain: 'credentials',
          path: unit.path,
          reason: `Orphan credential pool slot "${key}" has no valid consumer in pack`,
        });
      }
    } else if (section === 'nb_search') {
      if (nbSearchEntityId !== undefined) {
        link(credId, nbSearchEntityId);
      } else {
        excluded.push({
          id: credId,
          domain: 'credentials',
          path: unit.path,
          reason: 'Search credential block has no nb_search configuration in pack',
        });
      }
    } else if (section === 'nb_search_gui' && key !== undefined) {
      const parsed = nbSearchManagedCredentialsSchema.safeParse({ schema_version: '1', slots: { [key]: unit.value } });
      if (!parsed.success || (nbSearchEntityId === undefined && !liveHasNbSearch)) {
        excluded.push({
          id: credId,
          domain: 'credentials',
          path: unit.path,
          reason: 'Search GUI credential slot is invalid or lacks compatible nb_search configuration',
        });
      } else if (nbSearchEntityId !== undefined) {
        const entry = parsed.data.slots[key];
        const nbSearchCfg = object(packUnits.get('config:nb_search')?.value);
        const nbProviders = object(nbSearchCfg['providers']);
        const nbSlots = object(nbSearchCfg['credential_slots']);
        const slotCfg = object(nbSlots[key]);
        const matchesSlot = entry !== undefined
          && Object.hasOwn(nbSlots, key)
          && asNonEmptyString(slotCfg['provider_id']) === entry.provider_id;
        const matchesProvider = entry !== undefined && Object.hasOwn(nbProviders, entry.provider_id);
        if (matchesSlot || matchesProvider || (Object.keys(nbProviders).length === 0 && Object.keys(nbSlots).length === 0)) {
          link(credId, nbSearchEntityId);
        } else {
          excluded.push({
            id: credId,
            domain: 'credentials',
            path: unit.path,
            reason: `Search GUI credential slot "${key}" does not match any nb_search provider binding`,
          });
        }
      }
    }
  }

  for (const list of consumerItemIdsByCredential.values()) list.sort();
  for (const list of coupledCredentialsByEntityId.values()) list.sort();
  return { consumerItemIdsByCredential, coupledCredentialsByEntityId };
}

/** Builds the complete dependency graph, credential coupling, and model binding slots using real Kiki parsers. */
export function buildSubscriptionDependencyGraph(
  packUnits: Units,
  targetUnits: Units,
  initialExcluded: readonly PortableSpaceExcludedItem[] = [],
): SubscriptionDependencyGraph {
  const { entities, excluded: groupExcluded, entityIdByMemberUnitId } = groupUnitsIntoSelectableEntities(packUnits);
  if (entities.length > PORTABLE_SPACE_MAX_PREVIEW_ITEMS) {
    throw portableValidationError(`Subscription pack exceeds maximum ${PORTABLE_SPACE_MAX_PREVIEW_ITEMS} selectable items (${entities.length})`);
  }

  const excluded: PortableSpaceExcludedItem[] = [...initialExcluded, ...groupExcluded];
  const entityById = new Map<string, SelectableEntity>(entities.map((entity) => [entity.id, entity]));
  const { options: localModelOptions, optionIndexById, catalogRevision } = buildLocalModelCatalog(targetUnits);
  const { consumerItemIdsByCredential, coupledCredentialsByEntityId } = buildCredentialConsumerGraph(
    packUnits,
    targetUnits,
    entityIdByMemberUnitId,
    excluded,
  );

  const liveProviders = new Set<string>();
  for (const unit of targetUnits.values()) {
    if (unit.domain === 'config' && unit.key[0] === 'providers' && unit.key[1] !== undefined) {
      liveProviders.add(unit.key[1]);
    }
  }

  const metadataByEntityId = new Map<string, ParsedEntityMetadata>();
  const allSlots: PortableSpaceBindingSlot[] = [];
  const recipeConsumersByRecipeEntityId = new Map<string, string[]>();

  for (const entity of entities) {
    const edges: PortableSpaceDependencyEdge[] = [];
    const blockedDependencyIds: string[] = [];
    const warnings: string[] = [];
    const slots: PortableSpaceBindingSlot[] = [];
    let blockedReason: string | undefined;

    const unit = entity.anchorUnit;
    if (unit.domain === 'config' && unit.key[0] === 'models' && unit.key[1] !== undefined) {
      const cfg = object(unit.value);
      const providerId = asNonEmptyString(cfg['provider']) ?? asNonEmptyString(cfg['provider_id']);
      if (providerId !== undefined) {
        const providerUnitId = encodeUnitId('config', ['providers', providerId]);
        const liveSatisfied = liveProviders.has(providerId);
        addEdge(edges, { toId: providerUnitId, kind: 'hard', via: 'provider', liveSatisfied });
        if (!packUnits.has(providerUnitId) && !liveSatisfied) {
          blockedDependencyIds.push(providerUnitId);
        }
      }
      for (const file of extractPromptOverrideFiles(cfg['prompt_overrides'])) {
        const ref = resolvePromptTargetId(file, packUnits, targetUnits);
        addEdge(edges, { toId: ref.toId, kind: 'hard', via: 'prompt_overrides', liveSatisfied: ref.liveSatisfied });
        if (!packUnits.has(ref.toId) && !ref.liveSatisfied) blockedDependencyIds.push(ref.toId);
      }
      const recipeRef = extractRecipeRef(cfg['recipe']);
      if (recipeRef !== undefined) {
        const resolved = resolveRecipeTargetEntityId(recipeRef, entityById, targetUnits);
        if (resolved.toId !== undefined) {
          addEdge(edges, { toId: resolved.toId, kind: 'hard', via: 'recipe', liveSatisfied: resolved.liveSatisfied });
          if (!entityById.has(resolved.toId) && !resolved.liveSatisfied) blockedDependencyIds.push(resolved.toId);
          let consumers = recipeConsumersByRecipeEntityId.get(resolved.toId);
          if (consumers === undefined) {
            consumers = [];
            recipeConsumersByRecipeEntityId.set(resolved.toId, consumers);
          }
          if (!consumers.includes(entity.id)) consumers.push(entity.id);
        }
      }
    } else if (unit.domain === 'config' && unit.key[0] === 'prompt') {
      const cfg = object(unit.value);
      for (const file of extractPromptOverrideFiles(cfg['overrides'])) {
        const ref = resolvePromptTargetId(file, packUnits, targetUnits);
        addEdge(edges, { toId: ref.toId, kind: 'hard', via: 'prompt_overrides', liveSatisfied: ref.liveSatisfied });
        if (!packUnits.has(ref.toId) && !ref.liveSatisfied) blockedDependencyIds.push(ref.toId);
      }
    } else if (unit.domain === 'agents' && Buffer.isBuffer(unit.value)) {
      const text = unit.value.toString('utf8');
      try {
        const parsed = parseAgentFileText({
          path: unit.path,
          source: 'user',
          text,
        });
        for (const file of extractPromptOverrideFiles(parsed.promptOverrides)) {
          const ref = resolvePromptTargetId(file, packUnits, targetUnits);
          addEdge(edges, { toId: ref.toId, kind: 'hard', via: 'prompt_overrides', liveSatisfied: ref.liveSatisfied });
          if (!packUnits.has(ref.toId) && !ref.liveSatisfied) blockedDependencyIds.push(ref.toId);
        }
        const recipeRef = extractRecipeRef(parsed.recipe);
        if (recipeRef !== undefined) {
          const resolved = resolveRecipeTargetEntityId(recipeRef, entityById, targetUnits);
          if (resolved.toId !== undefined) {
            addEdge(edges, { toId: resolved.toId, kind: 'hard', via: 'recipe', liveSatisfied: resolved.liveSatisfied });
            if (!entityById.has(resolved.toId) && !resolved.liveSatisfied) blockedDependencyIds.push(resolved.toId);
          }
        }
        collectAgentProfileSlots(entity, parsed, packUnits, localModelOptions, optionIndexById, edges, slots);
      } catch (error) {
        blockedReason = error instanceof Error ? error.message : 'Invalid agent profile definition';
        excluded.push({
          id: entity.id,
          domain: 'agents',
          path: entity.path,
          reason: blockedReason.slice(0, 512),
        });
      }
      for (const memberId of entity.memberUnitIds) {
        if (memberId === entity.id) continue;
        const memberUnit = packUnits.get(memberId);
        if (memberUnit === undefined || !Buffer.isBuffer(memberUnit.value) || !memberUnit.path.endsWith('.md')) continue;
        const routeMatch = /^agents\/([^/]+)\/([^/]+)\.md$/u.exec(memberUnit.path);
        if (routeMatch === null) continue;
        const [, expectedProfile, expectedRouteName] = routeMatch;
        if (expectedRouteName === 'AGENT' || expectedRouteName === expectedProfile) continue;
        try {
          const routeParsed = parseAgentRouteFileText({
            path: memberUnit.path,
            expectedProfile: expectedProfile!,
            expectedRouteName: expectedRouteName!,
            text: memberUnit.value.toString('utf8'),
          });
          if (routeParsed.modelAlias !== undefined && !SPECIAL_MODEL_ALIASES.has(routeParsed.modelAlias)) {
            const alias = routeParsed.modelAlias;
            const modelUnitId = encodeUnitId('config', ['models', alias]);
            const liveSatisfied = optionIndexById.has(alias);
            if (packUnits.has(modelUnitId) || liveSatisfied) {
              addEdge(edges, { toId: modelUnitId, kind: 'soft', via: `route:${expectedRouteName}.model_alias`, liveSatisfied });
            }
            const tupleKey = formatBindingSlotTupleKey(entity.id, alias);
            if (!slots.some((slot) => slot.tupleKey === tupleKey)) {
              slots.push({
                tupleKey,
                itemId: entity.id,
                itemLabel: entity.label,
                itemScope: entity.scope,
                sourceModelId: alias,
                required: true,
                location: `route:${expectedRouteName}.model_alias`,
                eligibleOptionIndices: localModelOptions.map((_, idx) => idx),
                ...(liveSatisfied ? { currentLocalModelId: alias } : {}),
              });
            }
          }
        } catch (error) {
          warnings.push(`Route ${memberUnit.path}: ${error instanceof Error ? error.message : 'invalid route file'}`);
        }
      }
    } else if (unit.domain === 'personas' && Buffer.isBuffer(unit.value)) {
      const text = unit.value.toString('utf8');
      try {
        const parsed = parsePersonaFileText({ path: unit.path, text });
        if (parsed.profile !== undefined) {
          const profileUnitId = encodeUnitId('agents', [`agents/${parsed.profile}.md`]);
          const dirAgentId = encodeUnitId('agents', [`agents/${parsed.profile}/AGENT.md`]);
          const targetId = entityById.has(profileUnitId) ? profileUnitId : entityById.has(dirAgentId) ? dirAgentId : profileUnitId;
          const liveSatisfied = targetUnits.has(profileUnitId) || targetUnits.has(dirAgentId);
          if (entityById.has(targetId) || liveSatisfied) {
            addEdge(edges, { toId: targetId, kind: 'hard', via: 'persona_profile', liveSatisfied });
          }
        }
        if (parsed.modelAlias !== undefined && !SPECIAL_MODEL_ALIASES.has(parsed.modelAlias)) {
          const alias = parsed.modelAlias;
          const modelUnitId = encodeUnitId('config', ['models', alias]);
          const liveSatisfied = optionIndexById.has(alias);
          if (packUnits.has(modelUnitId) || liveSatisfied) {
            addEdge(edges, { toId: modelUnitId, kind: 'soft', via: 'persona.model_alias', liveSatisfied });
          }
          slots.push({
            tupleKey: formatBindingSlotTupleKey(entity.id, alias),
            itemId: entity.id,
            itemLabel: entity.label,
            itemScope: entity.scope,
            sourceModelId: alias,
            required: true,
            location: 'persona.model_alias',
            eligibleOptionIndices: localModelOptions.map((_, idx) => idx),
            ...(liveSatisfied ? { currentLocalModelId: alias } : {}),
          });
        }
      } catch (error) {
        blockedReason = error instanceof Error ? error.message : 'Invalid persona definition';
        excluded.push({
          id: entity.id,
          domain: 'personas',
          path: entity.path,
          reason: blockedReason.slice(0, 512),
        });
      }
    } else if (unit.domain === 'recipes' && Buffer.isBuffer(unit.value) && unit.path.endsWith('.toml')) {
      try {
        const rawToml = parseToml(unit.value);
        const parsed = recipeManifestSchema.safeParse(rawToml);
        if (parsed.success && parsed.data.extends !== undefined) {
          const ext = parsed.data.extends.source;
          if (!/^https?:\/\//i.test(ext)) {
            const resolved = resolveRecipeTargetEntityId(ext, entityById, targetUnits);
            if (resolved.toId !== undefined && resolved.toId !== entity.id) {
              addEdge(edges, { toId: resolved.toId, kind: 'hard', via: 'recipe_extends', liveSatisfied: resolved.liveSatisfied });
              if (!entityById.has(resolved.toId) && !resolved.liveSatisfied) blockedDependencyIds.push(resolved.toId);
            }
          }
        }
      } catch (error) {
        blockedReason = error instanceof Error ? error.message : 'Invalid recipe TOML';
        excluded.push({
          id: entity.id,
          domain: 'recipes',
          path: entity.path,
          reason: blockedReason.slice(0, 512),
        });
      }
    }

    const hardDependsOnIds = [...new Set(edges.filter((edge) => edge.kind === 'hard').map((edge) => edge.toId))].sort();
    const softDependsOnIds = [...new Set(edges.filter((edge) => edge.kind === 'soft').map((edge) => edge.toId))].sort();
    metadataByEntityId.set(entity.id, {
      entity,
      dependencyEdges: edges,
      softDependsOnIds,
      hardDependsOnIds,
      blockedDependencyIds: [...new Set(blockedDependencyIds)].sort(),
      blockedReason,
      warnings,
      coupledCredentialIds: coupledCredentialsByEntityId.get(entity.id) ?? [],
      slots,
    });
    allSlots.push(...slots);
  }

  for (const [recipeEntityId, modelConsumers] of recipeConsumersByRecipeEntityId) {
    const recipeMeta = metadataByEntityId.get(recipeEntityId);
    if (recipeMeta === undefined) continue;
    for (const modelEntityId of modelConsumers) {
      const liveSatisfied = targetUnits.has(modelEntityId);
      addEdge(recipeMeta.dependencyEdges, {
        toId: modelEntityId,
        kind: 'soft',
        via: 'bound_model',
        liveSatisfied,
      });
      if (!recipeMeta.softDependsOnIds.includes(modelEntityId)) {
        recipeMeta.softDependsOnIds.push(modelEntityId);
        recipeMeta.softDependsOnIds.sort();
      }
    }
  }

  let totalEdgeCount = 0;
  const referencedByIds = new Map<string, string[]>();
  for (const meta of metadataByEntityId.values()) {
    totalEdgeCount += meta.dependencyEdges.length;
    for (const edge of meta.dependencyEdges) {
      let refs = referencedByIds.get(edge.toId);
      if (refs === undefined) {
        refs = [];
        referencedByIds.set(edge.toId, refs);
      }
      if (!refs.includes(meta.entity.id)) refs.push(meta.entity.id);
    }
  }
  if (totalEdgeCount > PORTABLE_SPACE_MAX_PREVIEW_EDGES) {
    throw portableValidationError(`Subscription dependency graph exceeds maximum ${PORTABLE_SPACE_MAX_PREVIEW_EDGES} edges (${totalEdgeCount})`);
  }
  for (const list of referencedByIds.values()) list.sort();

  return {
    entities,
    entityById,
    entityIdByMemberUnitId,
    metadataByEntityId,
    referencedByIds,
    consumerItemIdsByCredential,
    bindingSlots: allSlots,
    localModelOptions,
    catalogRevision,
    excluded,
    totalEdgeCount,
  };
}

function targetKindForEntity(entity: SelectableEntity): UnboundModelHoldTargetKind {
  if (entity.domain === 'personas') return 'persona';
  if (entity.domain === 'recipes') return 'recipe';
  return 'profile';
}

function targetNameForEntity(entity: SelectableEntity): string {
  if (entity.domain === 'personas') {
    const match = /^personas\/([^/]+?)(?:\.md|\/.+)$/u.exec(entity.path);
    return match?.[1] ?? entity.label;
  }
  if (entity.domain === 'agents') {
    const match = /^agents\/([^/]+?)(?:\.md|\/.+)$/u.exec(entity.path);
    return match?.[1] ?? entity.label;
  }
  return entity.label;
}

function rewriteModelFrontmatter(
  rawText: string,
  kind: 'agent' | 'route' | 'persona',
  unitPath: string,
  remapBySourceAlias: ReadonlyMap<string, string>,
): string {
  if (remapBySourceAlias.size === 0) return rawText;
  const parsed = parseFrontmatter(rawText);
  const data = object(parsed.data);
  let nextText = rawText;

  const currentAlias = asNonEmptyString(data['model_alias']);
  if (currentAlias !== undefined && remapBySourceAlias.has(currentAlias)) {
    nextText = updateFrontmatterField(nextText, 'model_alias', remapBySourceAlias.get(currentAlias)!);
  }

  if (kind === 'agent' && Array.isArray(data['model_profiles'])) {
    let changedProfiles = false;
    const nextProfiles = data['model_profiles'].map((entry) => {
      const rec = object(entry);
      const alias = asNonEmptyString(rec['alias']);
      if (alias !== undefined && remapBySourceAlias.has(alias)) {
        changedProfiles = true;
        return { ...rec, alias: remapBySourceAlias.get(alias)! };
      }
      return entry;
    });
    if (changedProfiles) {
      nextText = updateFrontmatterField(nextText, 'model_profiles', nextProfiles);
    }
  }

  if (kind === 'agent') {
    parseAgentFileText({ path: unitPath, source: 'user', text: nextText });
  } else if (kind === 'persona') {
    parsePersonaFileText({ path: unitPath, text: nextText });
  } else {
    const routeMatch = /^agents\/([^/]+)\/([^/]+)\.md$/u.exec(unitPath);
    if (routeMatch !== null) {
      parseAgentRouteFileText({
        path: unitPath,
        expectedProfile: routeMatch[1]!,
        expectedRouteName: routeMatch[2]!,
        text: nextText,
      });
    }
  }
  return nextText;
}

export interface ModelBindingProjectionResult {
  readonly projectedUnits: Units;
  readonly holdsToUpsert: UnboundModelHoldEntry[];
  readonly clearedTargets: { readonly targetKind: UnboundModelHoldTargetKind; readonly targetName: string; readonly sourceModelId: string }[];
  readonly unresolvedSlots: PortableSpaceBindingSlot[];
  readonly invalidAssignments: { readonly tupleKey: string; readonly targetModelId: string; readonly reason: string }[];
}

/** Projects reviewed model-slot bindings onto selected consumer units while preserving raw upstream ancestry and recording explicit deferred holds. */
export function projectModelBindingsForSelection(input: {
  readonly rawUnits: Units;
  readonly selectedEntityIds: ReadonlySet<string>;
  readonly graph: SubscriptionDependencyGraph;
  readonly choices: PortableSpaceBindingChoices;
  readonly sourceId?: string;
  readonly strict?: boolean;
}): ModelBindingProjectionResult {
  const { rawUnits, selectedEntityIds, graph, choices, sourceId, strict = true } = input;
  const projectedUnits: Units = new Map(rawUnits);
  const holdsToUpsert: UnboundModelHoldEntry[] = [];
  const clearedTargets: { readonly targetKind: UnboundModelHoldTargetKind; readonly targetName: string; readonly sourceModelId: string }[] = [];
  const unresolvedSlots: PortableSpaceBindingSlot[] = [];
  const invalidAssignments: { readonly tupleKey: string; readonly targetModelId: string; readonly reason: string }[] = [];

  const optionIndexById = new Map<string, number>();
  graph.localModelOptions.forEach((opt, idx) => optionIndexById.set(opt.id, idx));
  const deferredSet = new Set(choices.unmappedModelPolicy === 'defer' ? (choices.deferredSlotIds ?? []) : []);
  const unitBindings = choices.unitModelBindings ?? {};
  const groupBindings = choices.modelBindings ?? {};
  const now = new Date().toISOString();

  const remapsByEntityId = new Map<string, Map<string, string>>();

  for (const slot of graph.bindingSlots) {
    if (!selectedEntityIds.has(slot.itemId)) continue;
    const entity = graph.entityById.get(slot.itemId);
    if (entity === undefined) continue;
    const eligibleSet = new Set(slot.eligibleOptionIndices);
    const packModelEntityId = encodeUnitId('config', ['models', slot.sourceModelId]);
    const packModelSelected = selectedEntityIds.has(packModelEntityId);
    const unitChoice = unitBindings[slot.tupleKey];
    const groupChoice = groupBindings[slot.sourceModelId];

    let resolvedTarget: string | undefined;
    let isDeferred = false;

    if (unitChoice !== undefined) {
      const idx = optionIndexById.get(unitChoice);
      if (idx === undefined || !eligibleSet.has(idx)) {
        invalidAssignments.push({
          tupleKey: slot.tupleKey,
          targetModelId: unitChoice,
          reason: slot.restrictionNote ?? `Local model "${unitChoice}" is not available or violates profile constraints for ${slot.itemLabel}`,
        });
        continue;
      }
      resolvedTarget = unitChoice;
    } else if (deferredSet.has(slot.tupleKey)) {
      isDeferred = true;
    } else if (groupChoice !== undefined) {
      const idx = optionIndexById.get(groupChoice);
      if (idx === undefined || !eligibleSet.has(idx)) {
        invalidAssignments.push({
          tupleKey: slot.tupleKey,
          targetModelId: groupChoice,
          reason: slot.restrictionNote ?? `Local model "${groupChoice}" is not available or violates profile constraints for ${slot.itemLabel}`,
        });
        continue;
      }
      resolvedTarget = groupChoice;
    } else if (packModelSelected) {
      resolvedTarget = slot.sourceModelId;
    } else if (slot.currentLocalModelId !== undefined && eligibleSet.has(optionIndexById.get(slot.currentLocalModelId) ?? -1)) {
      resolvedTarget = slot.currentLocalModelId;
    } else {
      if (slot.required) unresolvedSlots.push(slot);
      continue;
    }

    const targetKind = targetKindForEntity(entity);
    const targetName = targetNameForEntity(entity);

    if (isDeferred) {
      holdsToUpsert.push({
        tupleKey: slot.tupleKey,
        itemId: slot.itemId,
        targetKind,
        targetName,
        sourceModelId: slot.sourceModelId,
        location: slot.location,
        required: slot.required,
        ...(sourceId !== undefined ? { sourceId } : {}),
        recordedAt: now,
      });
    } else if (resolvedTarget !== undefined) {
      clearedTargets.push({ targetKind, targetName, sourceModelId: slot.sourceModelId });
      if (resolvedTarget !== slot.sourceModelId) {
        let remap = remapsByEntityId.get(slot.itemId);
        if (remap === undefined) {
          remap = new Map();
          remapsByEntityId.set(slot.itemId, remap);
        }
        remap.set(slot.sourceModelId, resolvedTarget);
      }
    }
  }

  if (strict && invalidAssignments.length > 0) {
    throw portableValidationError(invalidAssignments.map((item) => item.reason).join('; '));
  }
  if (strict && unresolvedSlots.length > 0) {
    const names = unresolvedSlots.map((slot) => `${slot.itemLabel} (${slot.sourceModelId})`).join(', ');
    throw portableValidationError(`Unresolved required model bindings: ${names}. Bind each model explicitly or choose defer in Subscription Center.`);
  }

  for (const [entityId, remap] of remapsByEntityId) {
    const entity = graph.entityById.get(entityId);
    if (entity === undefined) continue;
    for (const memberId of entity.memberUnitIds) {
      const unit = projectedUnits.get(memberId);
      if (unit === undefined || !Buffer.isBuffer(unit.value)) continue;
      if (unit.domain === 'personas' && unit.path.endsWith('.md')) {
        const nextText = rewriteModelFrontmatter(unit.value.toString('utf8'), 'persona', unit.path, remap);
        projectedUnits.set(memberId, { ...unit, value: Buffer.from(nextText, 'utf8') });
      } else if (unit.domain === 'agents' && unit.path.endsWith('.md')) {
        const isRoute = memberId !== entity.id && /^agents\/[^/]+\/[^/]+\.md$/u.test(unit.path);
        const nextText = rewriteModelFrontmatter(unit.value.toString('utf8'), isRoute ? 'route' : 'agent', unit.path, remap);
        projectedUnits.set(memberId, { ...unit, value: Buffer.from(nextText, 'utf8') });
      }
    }
  }

  return {
    projectedUnits,
    holdsToUpsert,
    clearedTargets,
    unresolvedSlots,
    invalidAssignments,
  };
}

/** Computes a deterministic SHA-256 digest of a sanitized unit map for snapshot/pack identity. */
export function computePackDigest(units: Units): string {
  const hash = createHash('sha256');
  const sortedIds = [...units.keys()].sort();
  for (const id of sortedIds) {
    const unit = units.get(id)!;
    hash.update(id);
    hash.update('\0');
    if (Buffer.isBuffer(unit.value)) hash.update(unit.value);
    else hash.update(JSON.stringify(unit.value));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Extracts the raw string key map for provider/model/credential safety validation. */
export function encodeConfigKeySegment(segment: string): string {
  return encodeUnitSegment(segment);
}
