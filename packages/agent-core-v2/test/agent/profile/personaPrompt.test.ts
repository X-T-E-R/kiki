import { describe, expect, it } from 'vitest';

import {
  applyPersonaPrompt,
  PERSONA_CAPABILITY_NOTICE,
  personaExamplesWereTruncated,
  renderPersonaBlock,
} from '#/agent/profile/personaPrompt';
import type { PersonaSnapshot } from '@kiki/agent-profiles/personaFile';

function snapshot(overrides: Partial<PersonaSnapshot['definition']> = {}, examples?: string): PersonaSnapshot {
  return {
    revision: 'r1',
    definition: {
      id: 'lin-lan',
      name: '林岚',
      title: '发布协调',
      description: '先给结论。',
      ...overrides,
    },
    examples,
  };
}

describe('persona prompt overlay', () => {
  it('replaces the default identity paragraph and preserves capability text', () => {
    const block = renderPersonaBlock(snapshot());
    const result = applyPersonaPrompt(
      'You are Kiki, an interactive general AI agent.\n\n# Language\n\nKeep going.',
      block,
    );

    expect(result).toContain('<persona name="林岚" title="发布协调">');
    expect(result).toContain('先给结论。');
    expect(result).toContain(PERSONA_CAPABILITY_NOTICE);
    expect(result).toContain('# Language');
    expect(result).not.toContain('You are Kiki');
  });

  it('uses an explicit persona marker and places the room prompt directly after the persona', () => {
    const block = renderPersonaBlock(snapshot());
    const result = applyPersonaPrompt('Before\n\n__KIKI_PERSONA_SLOT__\n\nAfter', block, '<room>Release</room>');

    expect(result).toBe(`Before\n\n${block.replace('</persona>', '</persona>\n\n<room>Release</room>')}\n\nAfter`);
    expect(result.indexOf('</persona>')).toBeLessThan(result.indexOf('<room>Release</room>'));
    expect(result.indexOf('<room>Release</room>')).toBeLessThan(result.indexOf(PERSONA_CAPABILITY_NOTICE));
  });

  it('truncates examples at the shared token estimate budget', () => {
    const persona = snapshot({}, 'x'.repeat(6_100));
    const result = renderPersonaBlock(persona);

    expect(personaExamplesWereTruncated(persona)).toBe(true);
    expect(result).toContain('<examples>');
    expect(result).toContain('</examples>');
    expect(result.length).toBeLessThan(6_200);
  });

  it('renders an empty persona marker when no persona is bound', () => {
    expect(applyPersonaPrompt('A __KIKI_PERSONA_SLOT__ B', undefined)).toBe('A  B');
  });
});
