import { describe, expect, it } from 'vitest';

import type { SkillDescriptor } from '@kiki/protocol';

import {
  buildSlashItems,
  classifySlashSubmission,
  completeSlashTrigger,
  extractSlashSkillTokens,
  filterSlashItems,
  findInlineSkillTokens,
  hasInlineSlashCandidate,
  isSkillActivatable,
  parseSlashDraft,
  parseSlashTrigger,
  removeSkillToken,
  resolveSlashCommand,
} from './slashCommands';

function skill(name: string, overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    name,
    description: `${name} skill`,
    path: `/skills/${name}/SKILL.md`,
    source: 'project',
    ...overrides,
  };
}

describe('parseSlashDraft', () => {
  it('returns null for non-slash drafts', () => {
    expect(parseSlashDraft('hello')).toBeNull();
    expect(parseSlashDraft('')).toBeNull();
    expect(parseSlashDraft('a /b')).toBeNull();
  });

  it('splits the command name from its args', () => {
    expect(parseSlashDraft('/')).toEqual({ query: '', args: '' });
    expect(parseSlashDraft('/rev')).toEqual({ query: 'rev', args: '' });
    expect(parseSlashDraft('/review --fix')).toEqual({ query: 'review', args: '--fix' });
    expect(parseSlashDraft('/review   --fix  now ')).toEqual({ query: 'review', args: '--fix  now' });
  });
});

describe('parseSlashTrigger / completeSlashTrigger', () => {
  it('finds leading and whitespace-delimited inline triggers at the caret', () => {
    expect(parseSlashTrigger('/rev', 4)).toEqual({
      start: 0,
      end: 4,
      query: 'rev',
      inline: false,
    });
    expect(parseSlashTrigger('please /rev the diff', 11)).toEqual({
      start: 7,
      end: 11,
      query: 'rev',
      inline: true,
    });
    expect(parseSlashTrigger('first line\n/rev', 15)).toEqual({
      start: 11,
      end: 15,
      query: 'rev',
      inline: true,
    });
  });

  it('ignores prose slashes, paths, and a caret outside the slash token', () => {
    expect(parseSlashTrigger('https://example.test', 20)).toBeNull();
    expect(parseSlashTrigger('use src/lib/file.ts', 12)).toBeNull();
    expect(parseSlashTrigger('please /review now', 6)).toBeNull();
  });

  it('replaces only the active inline token and preserves surrounding prose', () => {
    const text = 'please /rev the diff';
    const trigger = parseSlashTrigger(text, 11)!;
    expect(completeSlashTrigger(text, trigger, 'review')).toEqual({
      text: 'please /review the diff',
      cursor: 14,
    });

    const partial = 'before /revTAIL after';
    const middle = parseSlashTrigger(partial, 11)!;
    expect(completeSlashTrigger(partial, middle, 'review')).toEqual({
      text: 'before /review after',
      cursor: 14,
    });
  });
});

describe('buildSlashItems', () => {
  it('lists skills first, then client shortcuts', () => {
    const items = buildSlashItems([skill('review')], { hasSession: true });
    expect(items[0]?.kind).toBe('skill');
    expect(items.slice(1).every((item) => item.kind === 'action')).toBe(true);
  });

  it('hides session-only shortcuts without a session', () => {
    const names = buildSlashItems([], { hasSession: false }).map((item) => item.name);
    expect(names).toContain('plan');
    expect(names).toContain('goal');
    expect(names).toContain('new');
    expect(names).not.toContain('btw');
    expect(names).not.toContain('fork');
    expect(names).not.toContain('undo');
    expect(names).not.toContain('compact');
  });

  it('offers /btw once a session exists', () => {
    const items = buildSlashItems([], { hasSession: true });
    const match = resolveSlashCommand(items, '/btw what does this flag do?');
    expect(match?.item.action).toBe('btw');
    expect(match?.args).toBe('what does this flag do?');
  });

  it('reserves builtin action names and keeps same-name skills selectable', () => {
    const items = buildSlashItems([skill('plan'), skill('skill:plan'), skill('undo')], { hasSession: true });
    expect(resolveSlashCommand(items, '/PLAN')?.item.action).toBe('plan');
    expect(resolveSlashCommand(items, '/skill:skill:plan topic')?.item.skill?.name).toBe('plan');
    expect(resolveSlashCommand(items, '/skill:plan')?.item.skill?.name).toBe('skill:plan');
    expect(resolveSlashCommand(items, '/skill:undo')?.item.skill?.name).toBe('undo');
    const draftItems = buildSlashItems([skill('undo')], { hasSession: false });
    expect(resolveSlashCommand(draftItems, '/undo')).toBeNull();
    expect(resolveSlashCommand(draftItems, '/skill:undo')?.item.skill?.name).toBe('undo');
  });

  it('marks reference-type skills as disabled', () => {
    expect(isSkillActivatable(skill('glossary', { type: 'reference' }))).toBe(false);
    expect(isSkillActivatable(skill('review'))).toBe(true);
    expect(isSkillActivatable(skill('flow', { type: 'flow' }))).toBe(true);
    const items = buildSlashItems([skill('glossary', { type: 'reference' })], { hasSession: true });
    expect(items[0]?.disabled).toBe(true);
  });
});

describe('filterSlashItems', () => {
  const items = buildSlashItems(
    [skill('review'), skill('handoff'), skill('rebase')],
    { hasSession: true },
  );

  it('returns everything for an empty query', () => {
    expect(filterSlashItems(items, '')).toHaveLength(items.length);
  });

  it('ranks prefix matches above substring matches', () => {
    const filtered = filterSlashItems(items, 're');
    expect(filtered.map((item) => item.name).slice(0, 2)).toEqual(['review', 'rebase']);
  });

  it('matches case-insensitively', () => {
    expect(filterSlashItems(items, 'REV').map((item) => item.name)).toContain('review');
  });

  it('matches descriptions as a fallback', () => {
    const filtered = filterSlashItems(items, 'skill');
    expect(filtered.length).toBeGreaterThan(0);
  });
});

describe('resolveSlashCommand', () => {
  const items = buildSlashItems([skill('review'), skill('glossary', { type: 'reference' })], {
    hasSession: true,
  });

  it('resolves a skill with args', () => {
    const resolved = resolveSlashCommand(items, '/review --strict');
    expect(resolved?.item.name).toBe('review');
    expect(resolved?.args).toBe('--strict');
  });

  it('resolves a client shortcut', () => {
    const resolved = resolveSlashCommand(items, '/plan');
    expect(resolved?.item.kind).toBe('action');
    expect(resolved?.item.action).toBe('plan');
  });

  it('returns null for unknown commands (plain-text degradation)', () => {
    expect(resolveSlashCommand(items, '/nope hi')).toBeNull();
  });

  it('returns null for disabled skills', () => {
    expect(resolveSlashCommand(items, '/glossary')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(resolveSlashCommand(items, 'hello /review')).toBeNull();
  });
});

describe('classifySlashSubmission', () => {
  const items = buildSlashItems([skill('review'), skill('glossary', { type: 'reference' })], {
    hasSession: true,
  });

  it('classifies a runnable skill with its args', () => {
    expect(classifySlashSubmission(items, '/review fix it')).toEqual({
      kind: 'resolved',
      item: items[0],
      args: 'fix it',
    });
  });

  it('classifies a runnable client shortcut', () => {
    const classified = classifySlashSubmission(items, '/PLAN');
    expect(classified?.kind).toBe('resolved');
    if (classified?.kind === 'resolved') expect(classified.item.action).toBe('plan');
  });

  it('treats leading file paths and GUI route links as plain text, not an unknown command', () => {
    expect(classifySlashSubmission(items, '/etc/hosts has a stale entry')).toBeNull();
    expect(classifySlashSubmission(items, '/Users/example/src/index.ts:42')).toBeNull();
    expect(classifySlashSubmission(items, '/s/session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b 看一下这个线程')).toBeNull();
    expect(classifySlashSubmission(items, '/settings/models')).toBeNull();
    // A real typo still asks.
    expect(classifySlashSubmission(items, '/sessions')).toMatchObject({ kind: 'unknown', name: 'sessions' });
    expect(classifySlashSubmission(items, '/s')).toMatchObject({ kind: 'unknown', name: 's' });
  });

  it('tells an unknown command name apart from a disabled entry', () => {
    const unknown = classifySlashSubmission(items, '/revie stuff');
    expect(unknown).toMatchObject({ kind: 'unknown', name: 'revie', args: 'stuff' });

    const disabled = classifySlashSubmission(items, '/glossary notes');
    expect(disabled?.kind).toBe('disabled');
    if (disabled?.kind === 'disabled') {
      expect(disabled.item.name).toBe('glossary');
      expect(disabled.args).toBe('notes');
    }
  });

  it('ignores non-slash drafts and a bare slash', () => {
    expect(classifySlashSubmission(items, 'plain text')).toBeNull();
    expect(classifySlashSubmission(items, 'look /review')).toBeNull();
    expect(classifySlashSubmission(items, '/')).toBeNull();
    expect(classifySlashSubmission(items, '')).toBeNull();
  });
});

describe('findInlineSkillTokens / extractSlashSkillTokens / removeSkillToken', () => {
  const items = buildSlashItems(
    [
      skill('nb-writing'),
      skill('reader-first-writing'),
      skill('plan'),
      skill('glossary', { type: 'reference' }),
    ],
    { hasSession: true },
  );

  it('extracts single, multiple, multiline, and case-insensitive inline skills in first-occurrence order', () => {
    const result = extractSlashSkillTokens(
      items,
      '帮我用 /NB-WRITING 润色这段话\n再结合 /reader-first-writing 和 /nb-writing 检查',
      { includeLeading: true },
    );
    expect(result.activations.map((entry) => entry.skillName)).toEqual([
      'nb-writing',
      'reader-first-writing',
    ]);
    expect(result.occurrences.map((entry) => entry.commandName)).toEqual([
      'NB-WRITING',
      'reader-first-writing',
      'nb-writing',
    ]);
  });

  it('supports skill: fallback for inline reserved names while keeping leading shortcuts intact', () => {
    const leadingShortcut = extractSlashSkillTokens(items, '/plan inspect this', { includeLeading: true });
    expect(leadingShortcut.activations).toEqual([]);

    const inlineFallback = extractSlashSkillTokens(items, 'please /plan and /skill:plan this', { includeLeading: true });
    expect(inlineFallback.activations.map((entry) => entry.skillName)).toEqual(['plan']);
    expect(inlineFallback.occurrences).toHaveLength(2);
  });

  it('excludes reference skills, GUI route links, paths, URLs, and fractions', () => {
    const text = 'check /s/session_0f8e2a4c-1b3d /etc/hosts https://example.test/review 1/2 and /glossary';
    expect(hasInlineSlashCandidate('check /s/session_0f8e2a4c-1b3d /etc/hosts https://example.test/review 1/2')).toBe(false);
    expect(hasInlineSlashCandidate('check /reader-first-writing now')).toBe(true);
    expect(extractSlashSkillTokens(items, text, { includeLeading: true }).activations).toEqual([]);
    expect(
      findInlineSkillTokens(text, { isKnownSkill: () => true }).map((token) => token.commandName),
    ).toEqual(['glossary']);
  });

  it('omits tokens still under the active caret when activeCursor is supplied', () => {
    const text = 'please /nb-writing and /reader-first-writing';
    const whileTypingSecond = extractSlashSkillTokens(items, text, {
      includeLeading: true,
      activeCursor: text.length,
    });
    expect(whileTypingSecond.activations.map((entry) => entry.skillName)).toEqual(['nb-writing']);
  });

  it('removes leading, middle, and trailing skill tokens with clean spacing', () => {
    expect(removeSkillToken('/nb-writing check this', { start: 0, end: 11 })).toEqual({
      text: 'check this',
      cursor: 0,
    });
    expect(removeSkillToken('please /nb-writing check this', { start: 7, end: 18 })).toEqual({
      text: 'please check this',
      cursor: 7,
    });
    expect(removeSkillToken('check this /nb-writing', { start: 11, end: 22 })).toEqual({
      text: 'check this',
      cursor: 10,
    });
  });
});
