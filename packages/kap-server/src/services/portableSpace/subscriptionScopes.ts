import {
  PORTABLE_SUBSCRIPTION_SCOPES,
  type PortableSpaceDomain,
  type PortableSpaceExcludedItem,
  type PortableSubscriptionScope,
} from '@kiki/protocol';
import { RECIPE_INSTALLATIONS, RECIPE_STORE } from './recipeStore';
import type { SpaceUnit, Units } from './treeProjection';

export interface SelectableEntity {
  readonly id: string;
  readonly scope: PortableSubscriptionScope;
  readonly domain: PortableSpaceDomain;
  readonly label: string;
  readonly path: string;
  readonly memberUnitIds: readonly string[];
  readonly anchorUnit: SpaceUnit;
  readonly packageKind: 'single' | 'persona_dir' | 'agent_dir' | 'recipe_dir' | 'recipe_installation';
  readonly packageName?: string;
}

export function encodeUnitSegment(segment: string): string {
  return segment.replaceAll('%', '%25').replaceAll('.', '%2E');
}

export function encodeUnitId(domain: PortableSpaceDomain, key: readonly string[]): string {
  return `${domain}:${key.map(encodeUnitSegment).join('.')}`;
}

/** Maps a physical non-secret SpaceUnit to one of the 6 disjoint Subscription Center scopes. */
export function scopeForUnit(unit: Pick<SpaceUnit, 'domain' | 'key'>): PortableSubscriptionScope | undefined {
  switch (unit.domain) {
    case 'credentials':
    case 'sessions':
    case 'memories':
    case 'skills':
      return undefined;
    case 'plugins':
    case 'mcp':
      return 'extensions_search';
    case 'agents':
    case 'recipes':
      return 'agents_recipes';
    case 'personas':
      return 'personas';
    case 'instructions':
      return 'instructions';
    case 'appearance':
      return 'settings';
    case 'config': {
      const section = unit.key[0];
      if (section === undefined) return 'settings';
      if (section === 'providers' || section === 'models' || section === 'request_governance' || section === 'retry') {
        return 'models_providers';
      }
      if (section === 'nb_search' || section.startsWith('nb_search_')) {
        return 'extensions_search';
      }
      return 'settings';
    }
  }
}

function labelForUnit(unit: SpaceUnit): string {
  if (unit.domain === 'config') {
    if (unit.key[0] === 'providers' && unit.key[1] !== undefined) return `Provider: ${unit.key[1]}`;
    if (unit.key[0] === 'models' && unit.key[1] !== undefined) return unit.key[1];
    return unit.key.join('.');
  }
  if (unit.domain === 'mcp') return `MCP: ${unit.key[0] ?? unit.path}`;
  if (unit.domain === 'plugins') return `Plugin: ${unit.key[1] ?? unit.path}`;
  if (unit.domain === 'agents') {
    const match = /^agents\/([^/]+?)(?:\.md|\/.+)$/u.exec(unit.path);
    return match?.[1] ?? unit.path;
  }
  if (unit.domain === 'personas') {
    const match = /^personas\/([^/]+?)(?:\.md|\/.+)$/u.exec(unit.path);
    return match?.[1] ?? unit.path;
  }
  if (unit.domain === 'recipes') {
    if (unit.key[0] === 'installation' && unit.key[1] !== undefined) return `Recipe install: ${unit.key[1]}`;
    const match = /^recipes\/([^/]+?)(?:\.toml|\/.+)$/u.exec(unit.path);
    return match?.[1] ?? unit.path;
  }
  return unit.path.slice(0, 256);
}

/** Groups physical non-secret units into stable UI-selectable entities with canonical entry anchors. */
export function groupUnitsIntoSelectableEntities(units: Units): {
  readonly entities: SelectableEntity[];
  readonly excluded: PortableSpaceExcludedItem[];
  readonly entityIdByMemberUnitId: Map<string, string>;
} {
  const entities: SelectableEntity[] = [];
  const excluded: PortableSpaceExcludedItem[] = [];
  const entityIdByMemberUnitId = new Map<string, string>();
  const claimed = new Set<string>();

  const personaFolders = new Map<string, [string, SpaceUnit][]>();
  const agentFolders = new Map<string, [string, SpaceUnit][]>();
  const recipeFolders = new Map<string, [string, SpaceUnit][]>();
  const storeRecipeFolders = new Map<string, [string, SpaceUnit][]>();

  for (const [id, unit] of units) {
    if (unit.domain === 'personas') {
      const parts = unit.path.split('/');
      if (parts.length >= 3 && parts[0] === 'personas') {
        const folder = parts[1]!;
        let list = personaFolders.get(folder);
        if (list === undefined) {
          list = [];
          personaFolders.set(folder, list);
        }
        list.push([id, unit]);
      }
    } else if (unit.domain === 'agents') {
      const parts = unit.path.split('/');
      if (parts.length >= 3 && parts[0] === 'agents') {
        const folder = parts[1]!;
        let list = agentFolders.get(folder);
        if (list === undefined) {
          list = [];
          agentFolders.set(folder, list);
        }
        list.push([id, unit]);
      }
    } else if (unit.domain === 'recipes' && unit.key[0] !== 'installation') {
      if (unit.path.startsWith(RECIPE_STORE)) {
        const rest = unit.path.slice(RECIPE_STORE.length).split('/');
        const folder = rest[0];
        if (folder !== undefined && rest.length >= 2) {
          let list = storeRecipeFolders.get(folder);
          if (list === undefined) {
            list = [];
            storeRecipeFolders.set(folder, list);
          }
          list.push([id, unit]);
        }
      } else {
        const parts = unit.path.split('/');
        if (parts.length >= 3 && parts[0] === 'recipes') {
          const folder = parts[1]!;
          let list = recipeFolders.get(folder);
          if (list === undefined) {
            list = [];
            recipeFolders.set(folder, list);
          }
          list.push([id, unit]);
        }
      }
    }
  }

  for (const [folder, members] of personaFolders) {
    const anchor = members.find(([, unit]) => unit.path === `personas/${folder}/persona.md`);
    for (const [id] of members) claimed.add(id);
    if (anchor === undefined) {
      for (const [id, unit] of members) {
        excluded.push({
          id,
          domain: 'personas',
          path: unit.path,
          reason: `Persona package "${folder}" is missing required persona.md entry`,
        });
      }
      continue;
    }
    const memberUnitIds = members.map(([id]) => id).sort();
    for (const memberId of memberUnitIds) entityIdByMemberUnitId.set(memberId, anchor[0]);
    entities.push({
      id: anchor[0],
      scope: 'personas',
      domain: 'personas',
      label: folder.slice(0, 256),
      path: anchor[1].path,
      memberUnitIds,
      anchorUnit: anchor[1],
      packageKind: 'persona_dir',
      packageName: folder,
    });
  }

  for (const [folder, members] of agentFolders) {
    const standaloneId = encodeUnitId('agents', [`agents/${folder}.md`]);
    const dirAnchor = members.find(([, unit]) => unit.path === `agents/${folder}/AGENT.md` || unit.path === `agents/${folder}/${folder}.md`);
    if (dirAnchor !== undefined) {
      for (const [id] of members) claimed.add(id);
      const memberUnitIds = members.map(([id]) => id).sort();
      for (const memberId of memberUnitIds) entityIdByMemberUnitId.set(memberId, dirAnchor[0]);
      entities.push({
        id: dirAnchor[0],
        scope: 'agents_recipes',
        domain: 'agents',
        label: folder.slice(0, 256),
        path: dirAnchor[1].path,
        memberUnitIds,
        anchorUnit: dirAnchor[1],
        packageKind: 'agent_dir',
        packageName: folder,
      });
    } else if (units.has(standaloneId)) {
      const standaloneUnit = units.get(standaloneId)!;
      claimed.add(standaloneId);
      for (const [id] of members) claimed.add(id);
      const memberUnitIds = [standaloneId, ...members.map(([id]) => id)].sort();
      for (const memberId of memberUnitIds) entityIdByMemberUnitId.set(memberId, standaloneId);
      entities.push({
        id: standaloneId,
        scope: 'agents_recipes',
        domain: 'agents',
        label: folder.slice(0, 256),
        path: standaloneUnit.path,
        memberUnitIds,
        anchorUnit: standaloneUnit,
        packageKind: 'agent_dir',
        packageName: folder,
      });
    }
  }

  for (const [folder, members] of recipeFolders) {
    const anchor = members.find(([, unit]) => unit.path === `recipes/${folder}/recipe.toml`);
    if (anchor === undefined) continue;
    for (const [id] of members) claimed.add(id);
    const memberUnitIds = members.map(([id]) => id).sort();
    for (const memberId of memberUnitIds) entityIdByMemberUnitId.set(memberId, anchor[0]);
    entities.push({
      id: anchor[0],
      scope: 'agents_recipes',
      domain: 'recipes',
      label: folder.slice(0, 256),
      path: anchor[1].path,
      memberUnitIds,
      anchorUnit: anchor[1],
      packageKind: 'recipe_dir',
      packageName: folder,
    });
  }

  for (const [id, unit] of units) {
    if (claimed.has(id)) continue;
    const scope = scopeForUnit(unit);
    if (scope === undefined) continue;
    if (unit.domain === 'recipes' && unit.key[0] === 'installation' && unit.key[1] !== undefined) {
      const installId = unit.key[1];
      const storeMembers = storeRecipeFolders.get(installId) ?? [];
      for (const [memberId] of storeMembers) claimed.add(memberId);
      claimed.add(id);
      const memberUnitIds = [id, ...storeMembers.map(([memberId]) => memberId)].sort();
      for (const memberId of memberUnitIds) entityIdByMemberUnitId.set(memberId, id);
      entities.push({
        id,
        scope: 'agents_recipes',
        domain: 'recipes',
        label: labelForUnit(unit),
        path: `${RECIPE_INSTALLATIONS}/${installId}`,
        memberUnitIds,
        anchorUnit: unit,
        packageKind: 'recipe_installation',
        packageName: installId,
      });
      continue;
    }
    claimed.add(id);
    entityIdByMemberUnitId.set(id, id);
    entities.push({
      id,
      scope,
      domain: unit.domain,
      label: labelForUnit(unit),
      path: unit.path,
      memberUnitIds: [id],
      anchorUnit: unit,
      packageKind: 'single',
    });
  }

  const scopeRank = new Map<PortableSubscriptionScope, number>(
    PORTABLE_SUBSCRIPTION_SCOPES.map((scope, index) => [scope, index]),
  );
  entities.sort((a, b) => {
    const rankDiff = (scopeRank.get(a.scope) ?? 99) - (scopeRank.get(b.scope) ?? 99);
    if (rankDiff !== 0) return rankDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { entities, excluded, entityIdByMemberUnitId };
}
