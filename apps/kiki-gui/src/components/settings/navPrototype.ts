/**
 * Candidate settings navigations for the IA experiment (task-0033). These
 * trees sit next to the shipped SETTINGS_NAV_TREE and are only consulted when
 * the prototype switch (`lib/settingsIaPrototype`) is on; the shipped tree is
 * untouched. Both candidates keep every leaf reachable and every route,
 * deep link and object page unchanged — they regroup or re-home navigation,
 * never remove a destination.
 *
 * `taskflow`: eight task-semantic groups. Leaves, routes and tabs are the
 * shipped ones; only group membership, group labels and in-group order move.
 *
 * `objects`: taskflow with exactly one difference — Request identity joins
 * the AI page as a fourth tab (provider → model → defaults → identity is one
 * outbound-request path), so its leaf leaves the rail and
 * `/settings/identity` redirects to `/settings/ai?tab=identity`. Every other
 * group, label and in-group order is identical to `taskflow`, so the two
 * candidates differ by a single variable.
 */

import {
  SETTINGS_NAV_TREE,
  SETTINGS_SECTIONS,
  type SettingsNavGroupSpec,
  type SettingsNavNode,
} from '@kiki/session-core/settings';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { SettingsIaMode } from '../../lib/settingsIaPrototype';

export const TASKFLOW_NAV_TREE: readonly SettingsNavNode[] = [
  { kind: 'group', id: 'device', labelKey: 'st.group.device', sections: ['general', 'appearance', 'shortcuts'] },
  { kind: 'group', id: 'models-accounts', labelKey: 'st.group.modelsAccounts', sections: ['ai', 'identity'] },
  { kind: 'group', id: 'agents', labelKey: 'st.group.agents', sections: ['agents', 'subagents'] },
  { kind: 'group', id: 'sessions-work', labelKey: 'st.group.sessionsWork', sections: ['sessions', 'workspaces', 'memory', 'tasks'] },
  { kind: 'group', id: 'rules-alerts', labelKey: 'st.group.rulesAlerts', sections: ['permissions', 'notifications', 'hooks'] },
  { kind: 'group', id: 'capabilities', labelKey: 'st.group.capabilities', sections: ['plugins', 'skills', 'mcp', 'search', 'browser-control', 'computer-control'] },
  { kind: 'group', id: 'connection-spaces', labelKey: 'st.group.connectionSpaces', sections: ['connection', 'spaces', 'ssh', 'connection-services'] },
  { kind: 'group', id: 'system', labelKey: 'st.group.system', sections: ['developer', 'labs', 'about'] },
];

export const OBJECTS_NAV_TREE: readonly SettingsNavNode[] = [
  { kind: 'group', id: 'device', labelKey: 'st.group.device', sections: ['general', 'appearance', 'shortcuts'] },
  { kind: 'group', id: 'models-accounts', labelKey: 'st.group.modelsAccounts', sections: ['ai'] },
  { kind: 'group', id: 'agents', labelKey: 'st.group.agents', sections: ['agents', 'subagents'] },
  { kind: 'group', id: 'sessions-work', labelKey: 'st.group.sessionsWork', sections: ['sessions', 'workspaces', 'memory', 'tasks'] },
  { kind: 'group', id: 'rules-alerts', labelKey: 'st.group.rulesAlerts', sections: ['permissions', 'notifications', 'hooks'] },
  { kind: 'group', id: 'capabilities', labelKey: 'st.group.capabilities', sections: ['plugins', 'skills', 'mcp', 'search', 'browser-control', 'computer-control'] },
  { kind: 'group', id: 'connection-spaces', labelKey: 'st.group.connectionSpaces', sections: ['connection', 'spaces', 'ssh', 'connection-services'] },
  { kind: 'group', id: 'system', labelKey: 'st.group.system', sections: ['developer', 'labs', 'about'] },
];

/**
 * `purpose`: seven purpose-named groups (the revised Opus direction). Leaves,
 * routes and page ids are the shipped ones — identity stays a leaf, demoted
 * to the end of its group — and "workspaces" and "spaces" deliberately stay
 * in different groups. Three leaf labels and the AI providers tab are
 * disambiguated only while this tree is active (see
 * `PURPOSE_SECTION_LABEL_KEYS`); the shipped labels are untouched.
 */
export const PURPOSE_NAV_TREE: readonly SettingsNavNode[] = [
  { kind: 'group', id: 'device', labelKey: 'st.group.device', sections: ['general', 'appearance', 'shortcuts', 'notifications'] },
  { kind: 'group', id: 'models-agents', labelKey: 'st.group.modelsAgents', sections: ['ai', 'agents', 'subagents', 'identity'] },
  { kind: 'group', id: 'sessions-work', labelKey: 'st.group.sessionsWork', sections: ['sessions', 'workspaces', 'memory', 'tasks'] },
  { kind: 'group', id: 'capabilities', labelKey: 'st.group.capabilities', sections: ['skills', 'mcp', 'plugins', 'search', 'browser-control', 'computer-control'] },
  { kind: 'group', id: 'rules', labelKey: 'st.group.permissionsRules', sections: ['permissions', 'hooks'] },
  { kind: 'group', id: 'connection', labelKey: 'st.group.connection', sections: ['connection', 'spaces', 'ssh', 'connection-services'] },
  { kind: 'group', id: 'advanced', labelKey: 'st.group.advanced', sections: ['developer', 'labs', 'about'] },
];

/** Leaf labels the `purpose` candidate disambiguates; shipped keys are reused everywhere else. */
export const PURPOSE_SECTION_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  connection: 'st.section.serverConnection',
  'connection-services': 'st.section.externalAccess',
  tasks: 'st.section.tasksBackground',
};

/** The AI providers tab reads outbound accounts, not inbound "connection services". */
export const PURPOSE_AI_PROVIDERS_TAB_LABEL_KEY = 'st.ai.tab.providersAccounts' as const;

/**
 * Candidate-only leaf label: returns the disambiguated key when the active
 * tree is the purpose tree and the section is renamed there, else undefined
 * so the caller falls back to the shipped label.
 */
export function purposeSectionLabelKey(
  sectionId: string,
  tree: readonly SettingsNavNode[],
): I18nKey | undefined {
  return tree === PURPOSE_NAV_TREE ? PURPOSE_SECTION_LABEL_KEYS[sectionId] : undefined;
}

/** Sections whose leaf leaves the rail in `objects` mode, and where they go. */
export const OBJECTS_SECTION_REDIRECTS: Readonly<Record<string, string>> = {
  identity: 'ai?tab=identity',
};

/** The AI page's tabs in `objects` mode: the shipped three plus identity. */
export const OBJECTS_AI_TABS = ['providers', 'models', 'defaults', 'identity'] as const;

/** The nav tree a mode renders; null and unknown modes mean the shipped tree. */
export function navTreeForMode(mode: SettingsIaMode | null): readonly SettingsNavNode[] {
  return mode === 'taskflow' ? TASKFLOW_NAV_TREE
    : mode === 'objects' ? OBJECTS_NAV_TREE
    : mode === 'purpose' ? PURPOSE_NAV_TREE
    : SETTINGS_NAV_TREE;
}

/**
 * Group of a section under a candidate tree. A section the tree does not list
 * (identity in `objects` mode) borrows the group of the leaf that now hosts
 * it, so a search breadcrumb never loses its group line.
 */
export function prototypeGroupForSection(
  sectionId: string,
  tree: readonly SettingsNavNode[],
): SettingsNavGroupSpec | undefined {
  const host = tree.every((node) => node.kind !== 'group' || !node.sections.includes(sectionId))
    ? (Object.keys(OBJECTS_SECTION_REDIRECTS).includes(sectionId)
      ? OBJECTS_SECTION_REDIRECTS[sectionId]!.split('?')[0]!
      : sectionId)
    : sectionId;
  return tree.find(
    (node): node is SettingsNavGroupSpec => node.kind === 'group' && node.sections.includes(host),
  );
}

/** Where `/settings/<section>` lands in `objects` mode, or null when it stays. */
export function objectsSectionTarget(section: string): string | null {
  return OBJECTS_SECTION_REDIRECTS[section] ?? null;
}

/** Test oracle: every shipped leaf appears in the tree exactly once, minus merged-away ones. */
export function navTreeCoverage(tree: readonly SettingsNavNode[]): {
  placed: string[];
  missing: string[];
  duplicated: string[];
} {
  const placed = tree.flatMap((node) => node.kind === 'group' ? [...node.sections] : [node.section]);
  const all = SETTINGS_SECTIONS.map((section) => section.id);
  const missing = all.filter((id) => !placed.includes(id));
  const duplicated = placed.filter((id, index) => placed.indexOf(id) !== index);
  return { placed, missing, duplicated };
}
