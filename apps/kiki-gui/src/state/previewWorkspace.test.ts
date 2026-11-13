import { describe, expect, it } from 'vitest';

import { readPreviewSnapshot } from '../lib/navViewState';
import { classifyResource } from './previewResource';
import {
  activatePreviewTab,
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  EMPTY_PREVIEW_TABS,
  hostFileResource,
  movePreviewTab,
  openPreviewTab,
  previewTabKey,
  type PreviewTab,
} from './previewWorkspace';

describe('previewWorkspace tab reducer (#33)', () => {
  it('opens a new host-file resource tab appended and activated, and has all five tab kinds', () => {
    const state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a.ts');
    expect(state.tabs).toEqual([{ kind: 'resource', resource: hostFileResource('/a.ts') }]);
    expect(state.active).toBe('file:/a.ts');

    const fiveKinds: PreviewTab['kind'][] = ['resource', 'web', 'panel', 'skill', 'plugin'];
    expect(new Set(fiveKinds).size).toBe(5);
  });

  it('supports panel, web, skill, and plugin tabs alongside resource tabs', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a.ts');
    state = openPreviewTab(state, { kind: 'panel', agentId: 'agent-1', title: 'Worker 1' });
    state = openPreviewTab(state, { kind: 'web', url: 'https://example.com', title: 'Example' });
    state = openPreviewTab(state, { kind: 'skill', name: 'kiki-ops' });
    state = openPreviewTab(state, {
      kind: 'plugin',
      pluginId: 'kiki-phone',
      panelId: 'preview',
      title: 'Phone Preview',
    });
    expect(state.tabs).toEqual([
      { kind: 'resource', resource: hostFileResource('/a.ts') },
      { kind: 'panel', agentId: 'agent-1', title: 'Worker 1' },
      { kind: 'web', url: 'https://example.com', title: 'Example' },
      { kind: 'skill', name: 'kiki-ops' },
      { kind: 'plugin', pluginId: 'kiki-phone', panelId: 'preview', title: 'Phone Preview' },
    ]);
    expect(state.active).toBe('plugin:kiki-phone:preview');

    // Reopening an existing plugin tab updates a non-empty title without duplicating.
    state = openPreviewTab(state, '/a.ts');
    expect(state.active).toBe('file:/a.ts');
    state = openPreviewTab(state, {
      kind: 'plugin',
      pluginId: 'kiki-phone',
      panelId: 'preview',
      title: '手机预览',
    });
    expect(state.tabs).toHaveLength(5);
    expect(state.active).toBe('plugin:kiki-phone:preview');
    expect(state.tabs[4]).toEqual({
      kind: 'plugin',
      pluginId: 'kiki-phone',
      panelId: 'preview',
      title: '手机预览',
    });
  });

  it('keeps a built-in skill distinct from resource and panel tabs and reopens the same tab', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/work/kiki-ops/SKILL.md');
    state = openPreviewTab(state, { kind: 'skill', name: 'kiki-ops' });
    state = openPreviewTab(state, { kind: 'panel', agentId: 'kiki-ops' });
    expect(state.tabs.map((tab) => previewTabKey(tab))).toEqual([
      'file:/work/kiki-ops/SKILL.md',
      'skill:builtin:kiki-ops',
      'panel:kiki-ops',
    ]);
    state = openPreviewTab(state, { kind: 'skill', name: 'kiki-ops' });
    expect(state.tabs).toHaveLength(3);
    expect(state.active).toBe('skill:builtin:kiki-ops');
    state = closePreviewTab(state, 'skill:builtin:kiki-ops');
    expect(state.active).toBe('panel:kiki-ops');
  });

  it('collapses five spellings of one path into one resource tab while keeping its sent copy as a second tab (#33)', () => {
    const cwd = 'C:\\Work\\Project';
    const spellings = [
      'C:\\Work\\Project\\src\\app.ts',
      'c:/work/project/src/app.ts',
      'src/app.ts',
      'src/./sub/../app.ts:42:5',
      'file:///C:/Work/Project/src/app.ts#L42',
    ];
    let state = EMPTY_PREVIEW_TABS;
    for (const spelling of spellings) {
      state = openPreviewTab(state, spelling, cwd);
    }
    expect(state.tabs).toHaveLength(1);
    expect(state.active).toBe('file:c:/work/project/src/app.ts');

    const sentCopyTab: PreviewTab = {
      kind: 'resource',
      resource: {
        source: {
          kind: 'session-copy',
          sessionId: 'sess-1',
          fileId: 'blobref:main:copy1',
          sourceId: '1'.repeat(64),
        },
        origin: { path: 'C:/Work/Project/src/app.ts', trusted: true },
        type: classifyResource({ name: 'app.ts', mime: 'text/typescript' }),
        name: 'app.ts',
        mime: 'text/typescript',
      },
    };
    state = openPreviewTab(state, sentCopyTab, cwd);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs.map((tab) => previewTabKey(tab, cwd))).toEqual([
      'file:c:/work/project/src/app.ts',
      `attachment:sess-1:${encodeURIComponent('blobref:main:copy1')}:${'1'.repeat(64)}`,
    ]);
  });

  it('reopening an existing tab only activates it (no duplicate)', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a.ts');
    state = openPreviewTab(state, '/b.ts');
    state = openPreviewTab(state, '/a.ts');
    expect(state.tabs).toEqual([
      { kind: 'resource', resource: hostFileResource('/a.ts') },
      { kind: 'resource', resource: hostFileResource('/b.ts') },
    ]);
    expect(state.active).toBe('file:/a.ts');
  });

  it('closing the active tab activates the right neighbor, else the left', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a');
    state = openPreviewTab(state, '/b');
    state = openPreviewTab(state, '/c');
    state = activatePreviewTab(state, '/b');
    state = closePreviewTab(state, '/b');
    expect(state.tabs.map((tab) => previewTabKey(tab))).toEqual(['file:/a', 'file:/c']);
    expect(state.active).toBe('file:/c');
    state = closePreviewTab(state, '/c');
    expect(state.active).toBe('file:/a');
  });

  it('closing a background tab keeps the active tab', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a');
    state = openPreviewTab(state, '/b');
    state = closePreviewTab(state, '/a');
    expect(state.tabs.map((tab) => previewTabKey(tab))).toEqual(['file:/b']);
    expect(state.active).toBe('file:/b');
  });

  it('closing the last tab returns to the empty state', () => {
    const state = closePreviewTab(openPreviewTab(EMPTY_PREVIEW_TABS, '/a'), '/a');
    expect(state).toEqual(EMPTY_PREVIEW_TABS);
  });

  it('closeOthers keeps exactly the given tab active', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a');
    state = openPreviewTab(state, '/b');
    state = openPreviewTab(state, '/c');
    state = closeOtherPreviewTabs(state, '/a');
    expect(state.tabs.map((tab) => previewTabKey(tab))).toEqual(['file:/a']);
    expect(state.active).toBe('file:/a');
  });

  it('closeAll empties the workspace', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a');
    state = openPreviewTab(state, '/b');
    expect(closeAllPreviewTabs()).toEqual(EMPTY_PREVIEW_TABS);
  });

  it('moveTab reorders and clamps the target index', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a');
    state = openPreviewTab(state, '/b');
    state = openPreviewTab(state, '/c');
    expect(movePreviewTab(state, '/c', 0).tabs.map((tab) => previewTabKey(tab))).toEqual([
      'file:/c',
      'file:/a',
      'file:/b',
    ]);
    expect(movePreviewTab(state, '/a', 99).tabs.map((tab) => previewTabKey(tab))).toEqual([
      'file:/b',
      'file:/c',
      'file:/a',
    ]);
    const same = movePreviewTab(state, '/a', 0);
    expect(same).toBe(state);
  });

  it('unknown paths are no-ops', () => {
    const state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a');
    expect(closePreviewTab(state, '/nope')).toBe(state);
    expect(activatePreviewTab(state, '/nope')).toBe(state);
    expect(movePreviewTab(state, '/nope', 0)).toBe(state);
    expect(closeOtherPreviewTabs(state, '/nope')).toBe(state);
  });

  it('keeps a session-copy resource tab origin through open, re-open, and reorder with unchanged key', () => {
    const sourceId = 'a'.repeat(64);
    const origin = { path: '/workspace/notes.md', trusted: true as const };
    const attachmentTab: PreviewTab = {
      kind: 'resource',
      resource: {
        source: {
          kind: 'session-copy',
          sessionId: 'sess-1',
          fileId: 'blobref:main:abc',
          sourceId,
        },
        origin,
        type: 'markdown',
        name: 'notes.md',
        mime: 'text/markdown',
      },
    };
    const expectedKey = `attachment:sess-1:${encodeURIComponent('blobref:main:abc')}:${sourceId}`;
    expect(previewTabKey(attachmentTab)).toBe(expectedKey);

    let state = openPreviewTab(EMPTY_PREVIEW_TABS, attachmentTab);
    expect(state.active).toBe(expectedKey);
    expect(state.tabs[0]).toEqual(attachmentTab);

    state = openPreviewTab(state, '/workspace/other.ts');
    expect(state.active).toBe('file:/workspace/other.ts');

    const updatedTab: PreviewTab = {
      ...attachmentTab,
      size: 512,
    };
    state = openPreviewTab(state, updatedTab);
    expect(state.tabs).toHaveLength(2);
    expect(state.active).toBe(expectedKey);
    expect(state.tabs[0]?.kind === 'resource' ? state.tabs[0].resource.origin : undefined).toEqual(origin);
    expect(state.tabs[0]?.kind === 'resource' ? state.tabs[0].size : undefined).toBe(512);

    state = movePreviewTab(state, attachmentTab, 1);
    expect(state.tabs.map((tab) => previewTabKey(tab))).toEqual(['file:/workspace/other.ts', expectedKey]);
    expect(state.tabs[1]?.kind === 'resource' ? state.tabs[1].resource.origin : undefined).toEqual(origin);
  });

  it('reads legacy { kind: "file", path } snapshots into resource tabs while preserving panel, skill, plugin, active, and scroll positions (#33)', () => {
    const legacySnapshot = {
      tabsState: {
        tabs: [
          { kind: 'file', path: '/work/docs/design.md' },
          { kind: 'panel', agentId: 'sub-1', title: 'Worker' },
          { kind: 'skill', name: 'kiki-ops' },
          { kind: 'plugin', pluginId: 'kiki-phone', panelId: 'preview', title: 'Phone Preview' },
          { kind: 'unknown-future-kind', foo: 'bar' },
        ],
        active: 'plugin:kiki-phone:preview',
      },
      panelOpen: true,
      positions: {
        '/work/docs/design.md': { top: 240, left: 8 },
        'skill:builtin:kiki-ops': { top: 64 },
      },
    };
    const restored = readPreviewSnapshot(legacySnapshot);
    expect(restored).toBeDefined();
    expect(restored!.panelOpen).toBe(true);
    expect(restored!.tabsState.tabs).toEqual([
      { kind: 'resource', resource: hostFileResource('/work/docs/design.md') },
      { kind: 'panel', agentId: 'sub-1', title: 'Worker' },
      { kind: 'skill', name: 'kiki-ops' },
      { kind: 'plugin', pluginId: 'kiki-phone', panelId: 'preview', title: 'Phone Preview' },
    ]);
    expect(restored!.tabsState.active).toBe('plugin:kiki-phone:preview');
    expect(restored!.positions).toEqual({
      'file:/work/docs/design.md': { top: 240, left: 8 },
      'skill:builtin:kiki-ops': { top: 64 },
    });
  });
});
