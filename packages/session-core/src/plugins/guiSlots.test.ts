import { describe, expect, it } from 'vitest';

import type { PluginGuiSlotContribution } from '@kiki/protocol';

import type {
  PluginComposerToolbarSlotContribution,
  PluginMessageActionSlotContribution,
  PluginSettingsSectionSlotContribution,
  PluginSlashCommandSlotContribution,
  PluginStatusCapsuleSlotContribution,
  PluginToolCardRendererSlotContribution,
} from './guiSlots';
import {
  DRAFT_COMPOSER_TARGET,
  findToolCardRendererSlot,
  formatPluginToolFieldValue,
  interpolatePluginPromptText,
  normalizePluginToolMatchKeys,
  requestPluginPromptInsert,
  resolvePluginLocalizedText,
  resolvePluginToolFieldValue,
  selectComposerToolbarSlots,
  selectInspectorTabSlots,
  selectMessageActionSlots,
  selectSettingsSectionSlots,
  selectSidebarPanelSlots,
  selectSlashCommandSlots,
  selectStatusCapsuleSlots,
  selectToolCardRendererSlots,
  subscribePluginPromptInserts,
} from './guiSlots';
import { buildPluginSlashItems, buildSlashItems, extractSlashSkillTokens } from '../commands/slashCommands';

function composerSlot(
  pluginId: string,
  id: string,
  order: number,
  label = id,
): PluginComposerToolbarSlotContribution {
  return {
    slot: 'composer-toolbar',
    pluginId,
    id,
    label: { default: label },
    tone: 'neutral',
    order,
    action: { kind: 'insert_prompt', text: 'prompt' },
  };
}

function statusSlot(pluginId: string, id: string, order: number): PluginStatusCapsuleSlotContribution {
  return {
    slot: 'status-capsule',
    pluginId,
    id,
    label: { default: id },
    dotTone: 'idle',
    order,
  };
}

function messageSlot(
  pluginId: string,
  id: string,
  roles: PluginMessageActionSlotContribution['appliesToRoles'],
  order: number,
): PluginMessageActionSlotContribution {
  return {
    slot: 'message-action',
    pluginId,
    id,
    label: { default: id },
    appliesToRoles: roles,
    order,
    action: { kind: 'insert_prompt', text: 'prompt' },
  };
}

function slashSlot(
  pluginId: string,
  id: string,
  command: string,
  overrides: Partial<PluginSlashCommandSlotContribution> = {},
): PluginSlashCommandSlotContribution {
  return {
    slot: 'slash-command',
    pluginId,
    id,
    command,
    description: { default: `${command} description`, en: `${command} English`, zh: `${command} 中文` },
    needsSession: false,
    action: { kind: 'insert_prompt', text: 'prompt' },
    ...overrides,
  };
}

function toolCardSlot(
  pluginId: string,
  id: string,
  toolNames: string[],
): PluginToolCardRendererSlotContribution {
  return {
    slot: 'tool-card-renderer',
    pluginId,
    id,
    toolNames,
    actionVerb: { default: 'Run' },
    summaryFields: [],
    detailFields: [],
  };
}

function skill(name: string) {
  return {
    name,
    description: `${name} skill`,
    path: `/skills/${name}/SKILL.md`,
    source: 'project' as const,
  };
}

describe('plugin GUI slot selectors', () => {
  it('resolves localized text with locale normalization and default fallback', () => {
    const text = { default: 'Default', en: 'English', zh: '中文' };
    expect(resolvePluginLocalizedText(text, 'zh-CN')).toBe('中文');
    expect(resolvePluginLocalizedText(text, 'EN-us')).toBe('English');
    expect(resolvePluginLocalizedText(text, 'fr')).toBe('Default');
    expect(resolvePluginLocalizedText({ default: 'Default', en: '  ' }, 'en')).toBe('Default');
  });

  it('deduplicates ordered slots by latest value and sorts by order, plugin id, then slot id', () => {
    const slots: PluginGuiSlotContribution[] = [
      composerSlot('beta', 'same', 10, 'old'),
      composerSlot('zeta', 'first', 0),
      composerSlot('beta', 'same', 2, 'latest'),
      composerSlot('alpha', 'second', 2),
      statusSlot('beta', 'status', 1),
    ];
    expect(selectComposerToolbarSlots(slots).map((slot) => [slot.pluginId, slot.id, slot.order, slot.label.default]))
      .toEqual([
        ['zeta', 'first', 0, 'first'],
        ['alpha', 'second', 2, 'second'],
        ['beta', 'same', 2, 'latest'],
      ]);
    expect(selectStatusCapsuleSlots(slots).map((slot) => slot.id)).toEqual(['status']);
  });

  it('filters message actions by role and orders settings and sandboxed panel slots', () => {
    const settings: PluginSettingsSectionSlotContribution = {
      slot: 'settings-section',
      pluginId: 'example',
      id: 'later',
      title: { default: 'Later' },
      order: 2,
    };
    const sidebar = {
      slot: 'sidebar-panel',
      pluginId: 'example',
      id: 'sidebar',
      title: { default: 'Sidebar' },
      panelId: 'sidebar',
      bridge: 'kiki.panel.v1',
      order: 2,
    } satisfies PluginGuiSlotContribution;
    const inspector = {
      slot: 'inspector-tab',
      pluginId: 'example',
      id: 'inspector',
      title: { default: 'Inspector' },
      panelId: 'inspector',
      bridge: 'kiki.panel.v1',
      order: 1,
    } satisfies PluginGuiSlotContribution;
    const slots: PluginGuiSlotContribution[] = [
      messageSlot('zeta', 'assistant', ['assistant'], 2),
      messageSlot('alpha', 'user', ['user'], 1),
      messageSlot('beta', 'both', ['user', 'assistant'], 0),
      settings,
      { ...settings, id: 'earlier', order: 0 },
      sidebar,
      inspector,
    ];
    expect(selectMessageActionSlots(slots, 'user').map((slot) => slot.id)).toEqual(['both', 'user']);
    expect(selectMessageActionSlots(slots, 'assistant').map((slot) => slot.id)).toEqual(['both', 'assistant']);
    expect(selectSettingsSectionSlots(slots).map((slot) => slot.id)).toEqual(['earlier', 'later']);
    expect(selectSidebarPanelSlots(slots).map((slot) => slot.id)).toEqual(['sidebar']);
    expect(selectInspectorTabSlots(slots).map((slot) => slot.id)).toEqual(['inspector']);
  });

  it('deduplicates slash slots by latest entry and sorts by plugin id then slot id', () => {
    const slots: PluginGuiSlotContribution[] = [
      slashSlot('zeta', 'z', 'z-command'),
      slashSlot('alpha', 'z', 'old-command'),
      slashSlot('alpha', 'a', 'a-command'),
      slashSlot('alpha', 'a', 'latest-command'),
    ];
    expect(selectSlashCommandSlots(slots).map((slot) => [slot.pluginId, slot.id, slot.command])).toEqual([
      ['alpha', 'a', 'latest-command'],
      ['alpha', 'z', 'old-command'],
      ['zeta', 'z', 'z-command'],
    ]);
  });

  it('deduplicates tool-card renderers by key and matches exact names before normalized names', () => {
    const normalizedName = 'plugin__controller_ledger__ledger_read';
    const exact = toolCardSlot('exact', 'exact', [normalizedName]);
    const renderer = toolCardSlot('controller-ledger', 'read', ['ledger_read']);
    const slots: PluginGuiSlotContribution[] = [renderer, exact, { ...renderer, toolNames: ['newer'] }];
    expect(selectToolCardRendererSlots(slots)).toHaveLength(2);
    expect(normalizePluginToolMatchKeys('controller-ledger', 'ledger.read')).toEqual([
      'ledger.read',
      'plugin__controller_ledger__ledger_read',
    ]);
    expect(findToolCardRendererSlot(slots, normalizedName)).toBe(exact);
    expect(findToolCardRendererSlot([renderer], normalizedName)).toBe(renderer);
    expect(findToolCardRendererSlot([renderer], 'ledger_read')).toBe(renderer);
  });

  it('resolves safe dotted, bracketed, indexed, rooted, and unprefixed tool paths', () => {
    const sources = {
      args: { filePath: 'from args', items: [{ name: 'first' }] },
      result: { diagnostics: [{ message: 'bad input' }] },
      display: { summary: 'finished', filePath: 'from display' },
    };
    expect(resolvePluginToolFieldValue(sources, 'args.filePath')).toBe('from args');
    expect(resolvePluginToolFieldValue(sources, 'result.diagnostics[0].message')).toBe('bad input');
    expect(resolvePluginToolFieldValue(sources, 'args.items.0.name')).toBe('first');
    expect(resolvePluginToolFieldValue(sources, 'display.summary')).toBe('finished');
    expect(resolvePluginToolFieldValue(sources, 'filePath')).toBe('from args');
    expect(resolvePluginToolFieldValue({ args: null, display: { fallback: 'display' } }, 'fallback'))
      .toBe('display');
    expect(resolvePluginToolFieldValue(sources, 'args.__proto__.constructor')).toBeUndefined();
    expect(resolvePluginToolFieldValue(sources, 'args.constructor')).toBeUndefined();
    expect(resolvePluginToolFieldValue(sources, 'args.items[0].missing.value')).toBeUndefined();
    expect(resolvePluginToolFieldValue(sources, 'args.items[-1].name')).toBeUndefined();
  });

  it('formats field values according to their declarative display formats', () => {
    expect(formatPluginToolFieldValue(undefined)).toBeUndefined();
    expect(formatPluginToolFieldValue(null)).toBeUndefined();
    expect(formatPluginToolFieldValue('')).toBeUndefined();
    expect(formatPluginToolFieldValue('  one\n two  ', 'inline-text')).toBe('one two');
    expect(formatPluginToolFieldValue('line 1\nline 2', 'code')).toBe('line 1\nline 2');
    expect(formatPluginToolFieldValue(7)).toBe('7');
    expect(formatPluginToolFieldValue(false)).toBe('false');
    expect(formatPluginToolFieldValue({ a: 1, b: ' two ' }, 'key-value')).toBe('a: 1, b: two');
    expect(formatPluginToolFieldValue({ a: 1 }, 'code')).toBe(`{
  "a": 1
}`);
    expect(formatPluginToolFieldValue([1, 'two'])).toBe('[1,"two"]');
  });
});

describe('plugin slash command integration', () => {
  it('filters unavailable session commands, localizes content, and avoids occupied names case-insensitively', () => {
    const slots = [
      slashSlot('plug', 'builtin', 'PLAN'),
      slashSlot('plug', 'skill', 'write'),
      slashSlot('plugin', 'session', 'session-only', { needsSession: true }),
      slashSlot('alpha', 'first', 'custom'),
      slashSlot('beta', 'second', 'CUSTOM'),
      slashSlot('plug', 'localized', 'localized', {
        description: { default: 'Default', en: 'English', zh: '中文' },
        argumentHint: { default: 'Args', en: '--write', zh: '参数' },
      }),
    ];
    const items = buildPluginSlashItems(slots, {
      hasSession: false,
      locale: 'zh-CN',
      occupiedNames: new Set(['WRITE', 'plug:plan']),
    });
    expect(items.map((item) => item.name)).toEqual([
      'plug:PLAN:builtin',
      'plug:write',
      'custom',
      'beta:CUSTOM',
      'localized',
    ]);
    expect(items[0]).toMatchObject({ kind: 'plugin', pluginId: 'plug', slotId: 'builtin' });
    expect(items[0]?.pluginAction).toEqual({ kind: 'insert_prompt', text: 'prompt' });
    expect(items.at(-1)).toMatchObject({ description: '中文', argumentHint: '参数' });
  });

  it('places plugin items between skills and actions and never treats them as skill activations', () => {
    const slots: PluginGuiSlotContribution[] = [
      composerSlot('other', 'toolbar', 0),
      slashSlot('example-plugin', 'review', 'review'),
      slashSlot('example-plugin', 'run', 'run'),
    ];
    const items = buildSlashItems([skill('review'), skill('guide')], {
      hasSession: true,
      pluginSlots: slots,
      locale: 'en',
    });
    expect(items.map((item) => item.kind)).toEqual([
      'skill',
      'skill',
      'plugin',
      'plugin',
      'action',
      'action',
      'action',
      'action',
      'action',
      'action',
      'action',
    ]);
    expect(items[2]?.name).toBe('example-plugin:review');
    expect(items[3]?.name).toBe('run');
    expect(extractSlashSkillTokens(items, 'please /example-plugin:review and /guide', { includeLeading: true })
      .activations.map((entry) => entry.skillName)).toEqual(['guide']);
  });
});

describe('plugin prompt insertion bus', () => {
  it('routes draft and session inserts separately and releases listeners on unsubscribe', () => {
    const requests: string[] = [];
    const disposeDraft = subscribePluginPromptInserts(undefined, (request) => {
      requests.push(`draft:${request.text}`);
      return true;
    });
    const disposeSession = subscribePluginPromptInserts('session-1', (request) => {
      requests.push(`session:${request.text}`);
      return true;
    });

    expect(DRAFT_COMPOSER_TARGET).toBe('__new_draft__');
    expect(requestPluginPromptInsert(DRAFT_COMPOSER_TARGET, { text: 'draft prompt' })).toBe(true);
    expect(requestPluginPromptInsert('session-1', { text: 'session prompt', submit: true })).toBe(true);
    expect(requestPluginPromptInsert('session-2', { text: 'missing' })).toBe(false);
    expect(requests).toEqual(['draft:draft prompt', 'session:session prompt']);

    disposeDraft();
    disposeSession();
    expect(requestPluginPromptInsert(undefined, { text: 'after unsubscribe' })).toBe(false);
  });

  it('interpolates repeated arguments and appends non-empty arguments when no placeholder exists', () => {
    expect(interpolatePluginPromptText('Use $ARGUMENTS and $ARGUMENTS', '  --fix  '))
      .toBe('Use --fix and --fix');
    expect(interpolatePluginPromptText('Run $ARGUMENTS   ', '')).toBe('Run');
    expect(interpolatePluginPromptText('Review this', '  --strict  ')).toBe('Review this\n--strict');
    expect(interpolatePluginPromptText('Review this', '  ')).toBe('Review this');
  });
});
