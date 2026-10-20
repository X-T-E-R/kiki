// @vitest-environment jsdom

/**
 * Settings-IA experiment (task-0033): the two candidate navigations keep
 * every shipped destination reachable, the mode switch round-trips through
 * `?ia=` and localStorage, and the rail + search breadcrumbs follow the
 * candidate tree only while a mode is on.
 */

import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SETTINGS_NAV_TREE,
  SETTINGS_SEARCH_SPEC,
  buildSettingsSearchIndex,
  settingsSectionLabels,
  type SettingsNavGroupSpec,
  type SettingsNavNode,
} from '@kiki/session-core/settings';
import { I18nProvider } from '../../i18n';
import {
  captureIaPrototypeFromSearch,
  iaPrototypeModeSnapshot,
  readIaPrototypeMode,
  writeIaPrototypeMode,
} from '../../lib/settingsIaPrototype';
import {
  OBJECTS_NAV_TREE,
  PURPOSE_NAV_TREE,
  TASKFLOW_NAV_TREE,
  navTreeCoverage,
  navTreeForMode,
  objectsSectionTarget,
  prototypeGroupForSection,
  purposeSectionLabelKey,
} from './navPrototype';
import { SettingsNav } from './SettingsNav';

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  writeIaPrototypeMode(null);
});

afterEach(() => {
  writeIaPrototypeMode(null);
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(node: React.ReactNode, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

const noop = () => {};

describe('candidate nav trees', () => {
  it('taskflow keeps all 27 leaves exactly once, in eight task groups', () => {
    const { placed, missing, duplicated } = navTreeCoverage(TASKFLOW_NAV_TREE);
    expect(placed).toHaveLength(27);
    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
    const groups = TASKFLOW_NAV_TREE.filter((node) => node.kind === 'group');
    expect(groups.map((group) => group.id)).toEqual([
      'device', 'models-accounts', 'agents', 'sessions-work',
      'rules-alerts', 'capabilities', 'connection-spaces', 'system',
    ]);
    const sectionsOf = (id: string) =>
      (TASKFLOW_NAV_TREE.find((node) => node.kind === 'group' && node.id === id) as SettingsNavGroupSpecLike).sections;
    expect(sectionsOf('models-accounts')).toEqual(['ai', 'identity']);
    expect(sectionsOf('rules-alerts')).toEqual(['permissions', 'notifications', 'hooks']);
    expect(sectionsOf('capabilities')).toEqual(['plugins', 'skills', 'mcp', 'search', 'browser-control', 'computer-control']);
    expect(sectionsOf('connection-spaces')).toEqual(['connection', 'spaces', 'ssh', 'connection-services']);
  });

  it('objects folds identity into the AI page and differs from taskflow by exactly that leaf', () => {
    const { placed, missing, duplicated } = navTreeCoverage(OBJECTS_NAV_TREE);
    expect(placed).toHaveLength(26);
    expect(missing).toEqual(['identity']);
    expect(duplicated).toEqual([]);
    expect(objectsSectionTarget('identity')).toBe('ai?tab=identity');
    expect(objectsSectionTarget('permissions')).toBeNull();
    expect(objectsSectionTarget('ai')).toBeNull();
    // Single-variable contract: same groups in the same order as taskflow;
    // the only structural difference is identity leaving models-accounts.
    const groupsOf = (tree: readonly SettingsNavNode[]) =>
      tree.filter((node): node is SettingsNavGroupSpec => node.kind === 'group');
    expect(groupsOf(OBJECTS_NAV_TREE).map((node) => node.id))
      .toEqual(groupsOf(TASKFLOW_NAV_TREE).map((node) => node.id));
    for (const node of TASKFLOW_NAV_TREE) {
      if (node.kind !== 'group' || node.id === 'models-accounts') continue;
      const twin = OBJECTS_NAV_TREE.find((candidate) => candidate.kind === 'group' && candidate.id === node.id);
      expect(twin).toMatchObject({ labelKey: node.labelKey, sections: node.sections });
    }
    const accounts = OBJECTS_NAV_TREE.find((node) => node.kind === 'group' && node.id === 'models-accounts');
    expect(accounts?.kind === 'group' ? accounts.sections : []).toEqual(['ai']);
  });

  it('every shipped destination also exists in both candidates', () => {
    for (const node of SETTINGS_NAV_TREE) {
      if (node.kind !== 'group') continue;
      for (const leaf of node.sections) {
        if (leaf === 'identity') continue;
        if (leaf === 'extensions') {
          for (const sub of ['plugins', 'skills', 'mcp']) {
            expect(navTreeCoverage(TASKFLOW_NAV_TREE).placed).toContain(sub);
            expect(navTreeCoverage(OBJECTS_NAV_TREE).placed).toContain(sub);
          }
          continue;
        }
        expect(navTreeCoverage(TASKFLOW_NAV_TREE).placed).toContain(leaf);
        expect(navTreeCoverage(OBJECTS_NAV_TREE).placed).toContain(leaf);
      }
    }
  });

  it('groups resolve under a candidate tree, with identity borrowing its host', () => {
    expect(prototypeGroupForSection('permissions', TASKFLOW_NAV_TREE)?.id).toBe('rules-alerts');
    expect(prototypeGroupForSection('hooks', TASKFLOW_NAV_TREE)?.id).toBe('rules-alerts');
    expect(prototypeGroupForSection('identity', TASKFLOW_NAV_TREE)?.id).toBe('models-accounts');
    expect(prototypeGroupForSection('identity', OBJECTS_NAV_TREE)?.id).toBe('models-accounts');
    expect(prototypeGroupForSection('about', OBJECTS_NAV_TREE)?.id).toBe('system');
  });

  it('null mode means the shipped tree', () => {
    expect(navTreeForMode(null)).toBe(SETTINGS_NAV_TREE);
    expect(navTreeForMode('taskflow')).toBe(TASKFLOW_NAV_TREE);
    expect(navTreeForMode('objects')).toBe(OBJECTS_NAV_TREE);
    expect(navTreeForMode('purpose')).toBe(PURPOSE_NAV_TREE);
  });

  it('purpose keeps all 27 leaves exactly once in seven purpose groups, identity demoted to last', () => {
    const { placed, missing, duplicated } = navTreeCoverage(PURPOSE_NAV_TREE);
    expect(placed).toHaveLength(27);
    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
    expect(PURPOSE_NAV_TREE.filter((node) => node.kind === 'group').map((group) => group.id)).toEqual([
      'device', 'models-agents', 'sessions-work', 'capabilities', 'rules', 'connection', 'advanced',
    ]);
    const sectionsOf = (id: string) =>
      (PURPOSE_NAV_TREE.find((node) => node.kind === 'group' && node.id === id) as SettingsNavGroupSpecLike).sections;
    expect(sectionsOf('models-agents')).toEqual(['ai', 'agents', 'subagents', 'identity']);
    expect(sectionsOf('rules')).toEqual(['permissions', 'hooks']);
    // Workspaces and spaces deliberately stay in different groups.
    expect(sectionsOf('sessions-work')).toContain('workspaces');
    expect(sectionsOf('connection')).toContain('spaces');
    expect(purposeSectionLabelKey('connection', PURPOSE_NAV_TREE)).toBe('st.section.serverConnection');
    expect(purposeSectionLabelKey('connection', TASKFLOW_NAV_TREE)).toBeUndefined();
    expect(purposeSectionLabelKey('connection', SETTINGS_NAV_TREE)).toBeUndefined();
  });
});

interface SettingsNavGroupSpecLike { sections: readonly string[] }

describe('prototype mode switch', () => {
  it('captures ?ia= from the URL, persists it, and off clears it', () => {
    expect(readIaPrototypeMode()).toBeNull();
    expect(captureIaPrototypeFromSearch('')).toBeNull();
    expect(readIaPrototypeMode()).toBeNull();
    expect(captureIaPrototypeFromSearch('?ia=taskflow')).toBe('taskflow');
    expect(readIaPrototypeMode()).toBe('taskflow');
    expect(iaPrototypeModeSnapshot()).toBe('taskflow');
    expect(captureIaPrototypeFromSearch('?tab=models')).toBeNull();
    expect(readIaPrototypeMode()).toBe('taskflow');
    expect(captureIaPrototypeFromSearch('?ia=objects')).toBe('objects');
    expect(readIaPrototypeMode()).toBe('objects');
    expect(captureIaPrototypeFromSearch('?ia=off')).toBe('off');
    expect(readIaPrototypeMode()).toBeNull();
  });

  it('an unknown ?ia= value turns the experiment off rather than guessing', () => {
    writeIaPrototypeMode('taskflow');
    expect(captureIaPrototypeFromSearch('?ia=nonsense')).toBe('off');
    expect(readIaPrototypeMode()).toBeNull();
  });
});

describe('search breadcrumbs under a candidate tree', () => {
  it('a re-homed leaf shows its candidate group, and merged sections resolve to their host group', () => {
    const t = (key: string) => key;
    const labels = settingsSectionLabels(t);
    const taskflow = buildSettingsSearchIndex(labels, t, TASKFLOW_NAV_TREE);
    const permissions = taskflow.find((entry) => entry.section === 'permissions')!;
    expect(permissions.groupLabel).toBe('st.group.rulesAlerts');
    const objects = buildSettingsSearchIndex(labels, t, OBJECTS_NAV_TREE);
    const identity = objects.find((entry) => entry.section === 'ai' && entry.tab === 'identity')!;
    expect(identity.groupLabel).toBe('st.group.modelsAccounts');
    expect(identity.sectionLabel).toBe('st.section.ai');
    const shipped = buildSettingsSearchIndex(labels, t, SETTINGS_NAV_TREE);
    expect(shipped.find((entry) => entry.section === 'extensions')!.groupLabel).toBe('st.group.capabilities');
  });

  it('the shipped spec leaves every candidate destination intact', () => {
    const sections = new Set(SETTINGS_SEARCH_SPEC.map((entry) => entry.section));
    for (const section of sections) {
      if (section === 'identity') continue;
      if (section === 'extensions') {
        expect(navTreeCoverage(TASKFLOW_NAV_TREE).placed).toEqual(expect.arrayContaining(['plugins', 'skills', 'mcp']));
        expect(navTreeCoverage(OBJECTS_NAV_TREE).placed).toEqual(expect.arrayContaining(['plugins', 'skills', 'mcp']));
        continue;
      }
      expect(navTreeCoverage(TASKFLOW_NAV_TREE).placed).toContain(section);
      expect(navTreeCoverage(OBJECTS_NAV_TREE).placed).toContain(section);
    }
  });
});

describe('SettingsNav under the experiment', () => {
  it('renders the purpose tree and no picker', async () => {
    const container = await render(
      <SettingsNav active="ai" searchFocusToken={null} onNavigate={noop} onSearchHit={noop} />,
    );
    const groups = [...container.querySelectorAll('[data-settings-nav-group]')]
      .map((group) => group.getAttribute('data-settings-nav-group'));
    expect(groups).toEqual([
      'device', 'models-agents', 'sessions-work', 'capabilities', 'rules', 'connection', 'advanced',
    ]);
    expect(container.querySelector('[data-settings-ia-picker]')).toBeNull();
  });
});
