import { describe, expect, it } from 'vitest';

import type { SkillDescriptor } from '@moonshot-ai/protocol';

import {
  buildSlashItems,
  classifySlashSubmission,
  filterSlashItems,
  isSkillActivatable,
  parseSlashDraft,
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
    expect(names).not.toContain('fork');
    expect(names).not.toContain('undo');
    expect(names).not.toContain('compact');
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
