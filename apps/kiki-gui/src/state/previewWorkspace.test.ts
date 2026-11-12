import { describe, expect, it } from 'vitest';

import {
  activatePreviewTab,
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  EMPTY_PREVIEW_TABS,
  movePreviewTab,
  openPreviewTab,
  previewTabKey,
} from './previewWorkspace';

describe('previewWorkspace tab reducer', () => {
  it('opens a new tab appended and activated', () => {
    const state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a.ts');
    expect(state.tabs).toEqual([{ kind: 'file', path: '/a.ts' }]);
    expect(state.active).toBe('/a.ts');
  });

  it('supports panel tabs alongside file tabs', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a.ts');
    state = openPreviewTab(state, { kind: 'panel', agentId: 'agent-1', title: 'Worker 1' });
    expect(state.tabs).toEqual([
      { kind: 'file', path: '/a.ts' },
      { kind: 'panel', agentId: 'agent-1', title: 'Worker 1' },
    ]);
    expect(state.active).toBe('panel:agent-1');
  });

  it('keeps a built-in skill distinct from file and panel tabs and reopens the same tab', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/work/kiki-ops/SKILL.md');
    state = openPreviewTab(state, { kind: 'skill', name: 'kiki-ops' });
    state = openPreviewTab(state, { kind: 'panel', agentId: 'kiki-ops' });
    expect(state.tabs.map(previewTabKey)).toEqual(['/work/kiki-ops/SKILL.md', 'skill:builtin:kiki-ops', 'panel:kiki-ops']);
    state = openPreviewTab(state, { kind: 'skill', name: 'kiki-ops' });
    expect(state.tabs).toHaveLength(3);
    expect(state.active).toBe('skill:builtin:kiki-ops');
    state = closePreviewTab(state, 'skill:builtin:kiki-ops');
    expect(state.active).toBe('panel:kiki-ops');
  });

  it('reopening an existing tab only activates it (no duplicate)', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a.ts');
    state = openPreviewTab(state, '/b.ts');
    state = openPreviewTab(state, '/a.ts');
    expect(state.tabs).toEqual([
      { kind: 'file', path: '/a.ts' },
      { kind: 'file', path: '/b.ts' },
    ]);
    expect(state.active).toBe('/a.ts');
  });

  it('closing the active tab activates the right neighbor, else the left', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a');
    state = openPreviewTab(state, '/b');
    state = openPreviewTab(state, '/c');
    state = activatePreviewTab(state, '/b');
    state = closePreviewTab(state, '/b');
    expect(state.tabs.map(previewTabKey)).toEqual(['/a', '/c']);
    expect(state.active).toBe('/c');
    state = closePreviewTab(state, '/c');
    expect(state.active).toBe('/a');
  });

  it('closing a background tab keeps the active tab', () => {
    let state = openPreviewTab(EMPTY_PREVIEW_TABS, '/a');
    state = openPreviewTab(state, '/b');
    state = closePreviewTab(state, '/a');
    expect(state.tabs.map(previewTabKey)).toEqual(['/b']);
    expect(state.active).toBe('/b');
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
    expect(state.tabs.map(previewTabKey)).toEqual(['/a']);
    expect(state.active).toBe('/a');
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
    expect(movePreviewTab(state, '/c', 0).tabs.map(previewTabKey)).toEqual(['/c', '/a', '/b']);
    expect(movePreviewTab(state, '/a', 99).tabs.map(previewTabKey)).toEqual(['/b', '/c', '/a']);
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

  it('keeps an attachment tab origin through open, re-open, and reorder with unchanged key', () => {
    const sourceId = 'a'.repeat(64);
    const origin = { path: '/workspace/notes.md', trusted: true as const };
    const attachmentTab = {
      kind: 'attachment' as const,
      sessionId: 'sess-1',
      origin,
      item: {
        kind: 'file' as const,
        fileId: 'blobref:main:abc',
        sourceId,
        origin,
        name: 'notes.md',
        mime: 'text/markdown',
      },
    };
    const expectedKey = `attachment:sess-1:blobref:main:abc:${sourceId}`;
    expect(previewTabKey(attachmentTab)).toBe(expectedKey);

    let state = openPreviewTab(EMPTY_PREVIEW_TABS, attachmentTab);
    expect(state.active).toBe(expectedKey);
    expect(state.tabs[0]).toEqual(attachmentTab);

    state = openPreviewTab(state, '/workspace/other.ts');
    expect(state.active).toBe('/workspace/other.ts');

    state = openPreviewTab(state, attachmentTab);
    expect(state.tabs).toHaveLength(2);
    expect(state.active).toBe(expectedKey);
    expect(state.tabs[0]?.kind === 'attachment' ? state.tabs[0].origin : undefined).toEqual(origin);

    state = movePreviewTab(state, attachmentTab, 1);
    expect(state.tabs.map(previewTabKey)).toEqual(['/workspace/other.ts', expectedKey]);
    expect(state.tabs[1]?.kind === 'attachment' ? state.tabs[1].origin : undefined).toEqual(origin);
  });
});
