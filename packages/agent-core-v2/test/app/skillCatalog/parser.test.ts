import { describe, expect, it } from 'vitest';

import {
  SkillParseError,
  UnsupportedSkillTypeError,
  parseSkillText,
} from '#/app/skillCatalog/parser';

describe('parseSkillText', () => {
  it('parses a directory skill with required fields', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/commit/SKILL.md',
      skillDirName: 'commit',
      source: 'user',
      text: '---\nname: commit\ndescription: commit changes\n---\n# Commit',
    });
    expect(skill.name).toBe('commit');
    expect(skill.description).toBe('commit changes');
    expect(skill.source).toBe('user');
    expect(skill.content).toBe('# Commit');
  });

  it('applies metadata aliases', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/x/SKILL.md',
      skillDirName: 'x',
      source: 'user',
      text: '---\nname: x\ndescription: d\nwhen-to-use: when X\ndisable_model_invocation: true\n---\nbody',
    });
    expect(skill.metadata.whenToUse).toBe('when X');
    expect(skill.metadata.disableModelInvocation).toBe(true);
  });

  it('throws when a directory skill misses a required field', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '---\ndescription: d\n---\nbody',
      }),
    ).toThrow(SkillParseError);
  });

  it('throws when a directory skill has no frontmatter', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '# no frontmatter',
      }),
    ).toThrow(SkillParseError);
  });

  it('falls back to dir name and body description for flat skills', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/foo.md',
      skillDirName: 'foo',
      source: 'user',
      text: '# Foo skill\n\nDoes foo.',
    });
    expect(skill.name).toBe('foo');
    expect(skill.description).toBe('# Foo skill');
  });

  it('treats command files as explicit user prompts even when metadata requests otherwise', () => {
    const skill = parseSkillText({
      skillMdPath: '/workspace/.kiki/commands/brainstorm.md',
      skillDirName: 'brainstorm',
      source: 'project',
      text: '---\ndescription: Discuss options\nargument-hint: "<topic>"\ndisable-model-invocation: false\ntype: flow\n---\nDiscuss $ARGUMENTS without creating files.',
    });
    expect(skill.name).toBe('brainstorm');
    expect(skill.metadata).toMatchObject({
      promptCommand: true, disableModelInvocation: true, type: 'prompt', argumentHint: '<topic>',
    });
    expect(skill.content).toBe('Discuss $ARGUMENTS without creating files.');
  });

  it('allows plain command files but rejects names that cannot be slash tokens', () => {
    const input = {
      skillMdPath: '/home/commands/brainstorm.md', skillDirName: 'brainstorm', source: 'user' as const,
      text: 'Discuss options.',
    };
    expect(parseSkillText(input).metadata.disableModelInvocation).toBe(true);
    expect(() => parseSkillText({ ...input, text: '---\nname: two words\n---\nDiscuss.' })).toThrow(SkillParseError);
  });

  it('throws on an unsupported skill type', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '---\nname: x\ndescription: d\ntype: bogus\n---\nbody',
      }),
    ).toThrow(UnsupportedSkillTypeError);
  });

  it('extracts mermaid and d2 flowchart blocks', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/x/SKILL.md',
      skillDirName: 'x',
      source: 'user',
      text: '---\nname: x\ndescription: d\n---\n```mermaid\ngraph TD\n```\n\n```d2\nx -> y\n```',
    });
    expect(skill.mermaid).toBe('graph TD');
    expect(skill.d2).toBe('x -> y');
  });
});
