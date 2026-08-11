import { describe, expect, it } from 'vitest';

import type { SkillDescriptor } from '@moonshot-ai/protocol';

import {
  buildSlashItems,
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
