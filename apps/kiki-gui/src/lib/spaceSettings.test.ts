import { describe, expect, it } from 'vitest';

import type { SpaceDetail, SpacePreview } from '@kiki/protocol';
import { translate, type I18nKey } from '@kiki/session-core/i18n';

import {
  SPACE_GROUP_ORDER,
  SPACE_ITEM_IDS,
  spaceBlockedReasonText,
  spaceConfigItemId,
  spaceGroupSummaryText,
  spaceItemLabel,
  spaceItemRoute,
  spaceOwnChoices,
  spacePreviewSections,
  spaceValueLabel,
  type SpacePreviewRow,
} from './spaceSettings';

const t = (key: I18nKey, params?: Record<string, string | number>) => translate('en', key, params);

function item(id: string, fields: Partial<SpaceDetail['items'][number]> = {}): SpaceDetail['items'][number] {
  return {
    id, name: id.split(':').at(-1) ?? id, domain: 'config', kind: 'config',
    selection: { mode: 'follow' }, stored: null, effective: null, main: null, actual: null,
    origin: 'main', available: true, pending: false, activation: 'immediate',
    revision: 'r1', main_revision: 'r0', dependencies: [], can_push: true,
    ...fields,
  };
}

function detail(fields: Partial<SpaceDetail> = {}): SpaceDetail {
  return {
    schema: 2, id: 'h-acme', name: 'ACME', primary: false, revision: 'r1',
    inherit: {
      config: true, agents: true, instructions: true, skills: true, mcp: true,
      appearance: true, plugins: false, credentials: 'shared', generic_roots: true,
    },
    groups: [
      { domain: 'config', mode: 'follow', fixed_count: 2, follow_count: 3 },
      { domain: 'appearance', mode: 'follow', fixed_count: 1, follow_count: 0 },
      { domain: 'plugins', mode: 'fixed', fixed_count: 0, follow_count: 1 },
      { domain: 'credentials', mode: 'follow', fixed_count: 0, follow_count: 1 },
      { domain: 'generic_roots', mode: 'follow', fixed_count: 0, follow_count: 1 },
    ],
    items: [],
    preferences: {
      theme: 'dark', skin: { source: 'builtin', id: 'inkstone' }, tweaks: {},
      background: { light: null, dark: null, linked: true, assist: true },
      proseFont: 'serif', defaultAppendTiming: 'agent_idle', foldSteps: true, worktreeSkipConfirm: false,
    },
    preference_authority: true, restart_required: false,
    ...fields,
  };
}

function row(id: string, fields: Partial<SpacePreviewRow> = {}): SpacePreviewRow {
  return {
    id, name: id, domain: 'config', before: 'a', after: 'b',
    selected: true, same_value: false, main_changed: false, conflict: false, dependencies: [], ...fields,
  };
}

describe('space group summaries', () => {
  it('reports the real mode and counts, never a guess from equal values', () => {
    const space = detail();
    expect(spaceGroupSummaryText(space, 'config', t)).toBe('Follows the main space · 2 set here');
    expect(spaceGroupSummaryText(space, 'appearance', t)).toBe('Follows the main space · 1 set here');
    expect(spaceGroupSummaryText(space, 'plugins', t)).toBe('Set in this space · 1 still follow the main space');
    expect(spaceGroupSummaryText(space, 'skills', t)).toBe('Source not readable yet');
  });

  it('names the account mode and the shared-folder source in their own words', () => {
    expect(spaceGroupSummaryText(detail(), 'credentials', t)).toBe('Shared with the main space');
    expect(spaceGroupSummaryText(detail({ inherit: { ...detail().inherit, credentials: 'isolated' } }), 'credentials', t)).toBe('This space only');
    expect(spaceGroupSummaryText(detail(), 'generic_roots', t)).toBe('Available');
    expect(spaceGroupSummaryText(detail({ inherit: { ...detail().inherit, generic_roots: false } }), 'generic_roots', t)).toBe('Not used');
  });

  it('keeps the instructions stack as its own case', () => {
    const stacked = detail({
      inherit: { ...detail().inherit, instructions: 'stack' },
      groups: [{ domain: 'instructions', mode: 'follow', fixed_count: 0, follow_count: 1 }],
    });
    expect(spaceGroupSummaryText(stacked, 'instructions', t)).toBe('Follows the main space, plus this space’s own additions');
  });

  it('never labels the main space as following itself', () => {
    const main = detail({ id: 'main', primary: true, groups: [{ domain: 'config', mode: 'fixed', fixed_count: 7, follow_count: 0 }] });
    expect(spaceGroupSummaryText(main, 'config', t)).toBe('7 items');
  });
});

describe('what a space set for itself', () => {
  it('lists only what this space holds, in reading order, without source rows', () => {
    const space = detail({
      items: [
        item('pref:theme', { domain: 'appearance', name: 'Theme', kind: 'preference', origin: 'home', selection: { mode: 'fixed', reason: 'edited' } }),
        item('config:default_model', { name: 'Default model', origin: 'home', effective: 'kiki-pro', selection: { mode: 'fixed', reason: 'edited' } }),
        item('pref:skip', { domain: 'appearance', name: 'Followed', kind: 'preference', origin: 'main' }),
        item('source:credentials', { domain: 'credentials', name: 'Accounts', kind: 'source', origin: 'isolated' }),
      ],
    });
    expect(spaceOwnChoices(space).map((entry) => entry.id)).toEqual(['config:default_model', 'pref:theme']);
  });
});

describe('value labels', () => {
  it('writes preference values in the words the person chose them with', () => {
    expect(spaceValueLabel(SPACE_ITEM_IDS.theme, 'dark', t)).toBe('Dark');
    expect(spaceValueLabel(SPACE_ITEM_IDS.proseFont, 'serif', t)).toBe('Serif');
    expect(spaceValueLabel(SPACE_ITEM_IDS.defaultAppendTiming, 'tasks_done', t)).toBe('When tasks finish');
    expect(spaceValueLabel(SPACE_ITEM_IDS.skin, { source: 'builtin', id: 'inkstone' }, t)).toBe('inkstone (built-in)');
    expect(spaceValueLabel(SPACE_ITEM_IDS.tweaks, {}, t)).toBe('No tweaks');
    expect(spaceValueLabel(SPACE_ITEM_IDS.tweaks, { accent: '#b23' }, t)).toBe('1 tweaks');
    expect(spaceValueLabel(SPACE_ITEM_IDS.foldSteps, true, t)).toBe('On');
    expect(spaceValueLabel(SPACE_ITEM_IDS.background, null, t)).toBe('No background');
  });

  it('falls back to plain words rather than an internal shape', () => {
    expect(spaceValueLabel('config:default_model', 'fixture/kiki-pro', t)).toBe('fixture/kiki-pro');
    expect(spaceValueLabel('config:default_plan_mode', false, t)).toBe('Off');
    expect(spaceValueLabel('config:x', null, t)).toBe('None');
    expect(spaceValueLabel('resource:skills:a', { files: ['a.md'], bytes: 12 }, t)).toBe('{"files":["a.md"],"bytes":12}');
  });
});

describe('preview sections', () => {
  it('separates real differences, equal values and the future-items lines', () => {
    const preview = {
      rows: [row('a'), row('b', { same_value: true }), row('group:config', { id: 'group:config' })],
    } as unknown as SpacePreview;
    const sections = spacePreviewSections(preview);
    expect(sections.changed.map((entry) => entry.id)).toEqual(['a']);
    expect(sections.same.map((entry) => entry.id)).toEqual(['b']);
    expect(sections.groups.map((entry) => entry.id)).toEqual(['group:config']);
  });
});

describe('blocked reasons and edit points', () => {
  it('speaks for the reasons it knows and repeats the rest unchanged', () => {
    expect(spaceBlockedReasonText('Resource content is unavailable', t)).toBe('This item’s files are not available here yet.');
    expect(spaceBlockedReasonText('Connection contains account data; use the dedicated MCP account flow', t))
      .toBe('This connection holds account data; change it in the account flow.');
    expect(spaceBlockedReasonText('Something the server thought of later', t)).toBe('Something the server thought of later');
  });

  it('links only the edit points this GUI can name', () => {
    expect(spaceItemRoute('pref:theme')).toBe('/settings/appearance');
    expect(spaceItemRoute('pref:foldSteps')).toBe('/settings/general');
    expect(spaceItemRoute('config:default_permission_mode')).toBe('/settings/permissions');
    expect(spaceItemRoute('resource:skills:paper-search')).toBe('/settings/skills');
    expect(spaceItemRoute('resource:instructions:AGENTS.md')).toBeUndefined();
    expect(spaceItemRoute('config:some_future_key')).toBeUndefined();
  });

  it('keeps the group reading order the page uses', () => {
    expect(SPACE_GROUP_ORDER).toEqual(['config', 'appearance', 'agents', 'instructions', 'skills', 'mcp', 'credentials', 'plugins']);
  });
});

describe('item names and wire ids', () => {
  it('builds a config id from the domain and path the config page speaks', () => {
    expect(spaceConfigItemId('default_model')).toBe('config:default_model');
    expect(spaceConfigItemId('session_title', ['model'])).toBe('config:session_title.model');
    expect(spaceConfigItemId('subagent', ['defaultModel'])).toBe('config:subagent.default_model');
  });

  it('names with the title this interface already has, and leaves the rest as they came', () => {
    expect(spaceItemLabel('pref:theme', 'Theme mode', t)).toBe('Theme');
    expect(spaceItemLabel('pref:defaultAppendTiming', 'Append timing', t)).toBe('Queued messages');
    expect(spaceItemLabel('pref:foldSteps', 'Fold tool steps', t)).toBe('Fold consecutive reads');
    expect(spaceItemLabel('config:thinking.effort', 'Default thinking effort', t)).toBe('Effort');
    expect(spaceItemLabel('config:default_plan_mode', 'Default plan mode', t)).toBe('Default to entering plan mode');
    // A resource, a model or a service label is what the person typed: shown
    // as the server sent it, never translated.
    expect(spaceItemLabel('resource:skills:paper-search', 'paper-search', t)).toBe('paper-search');
    expect(spaceItemLabel('config:some_future_key', 'Some future key', t)).toBe('Some future key');
  });
});
