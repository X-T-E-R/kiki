import { describe, expect, it } from 'vitest';

import {
  PersonaFileParseError,
  parsePersonaFileText,
  serializePersonaFile,
} from '#/personaFile';

const TEXT = `---
name: 林岚
title: 发布协调
job: 负责发布节奏
profile: agent
model_alias: fast-model
thinking_effort: medium
greeting: 我在。
greetings: [你好, 嗨]
room_greeting: 一起开始吧
delivery: message
memory:
  shared: [global, workspace]
skills: [release-notes]
tags: [work]
notes: maintainer
home_workspace: /work/kiki
---
你是林岚。

先给结论。
`;

describe('personaFile', () => {
  it('parses the closed markdown format into camelCase', () => {
    expect(parsePersonaFileText({ path: '/personas/lin-lan/persona.md', text: TEXT })).toEqual({
      id: 'lin-lan',
      name: '林岚',
      title: '发布协调',
      job: '负责发布节奏',
      profile: 'agent',
      modelAlias: 'fast-model',
      thinkingEffort: 'medium',
      greeting: '我在。',
      greetings: ['你好', '嗨'],
      roomGreeting: '一起开始吧',
      delivery: 'message',
      memory: { shared: ['global', 'workspace'] },
      skills: ['release-notes'],
      tags: ['work'],
      notes: 'maintainer',
      homeWorkspace: '/work/kiki',
      description: '你是林岚。\n\n先给结论。',
    });
  });

  it('rejects permission fields and unknown keys', () => {
    expect(() => parsePersonaFileText({
      path: '/personas/lin-lan/persona.md',
      text: '---\nname: Lin\ntools: [Bash]\n---\nbody',
    })).toThrow(/permissions belong to the referenced profile/);
    expect(() => parsePersonaFileText({
      path: '/personas/lin-lan/persona.md',
      text: '---\nname: Lin\nunknown_key: value\n---\nbody',
    })).toThrow(PersonaFileParseError);
  });

  it('round-trips canonical fields and body', () => {
    const parsed = parsePersonaFileText({ path: '/personas/lin-lan/persona.md', text: TEXT });
    const serialized = serializePersonaFile(parsed);
    expect(parsePersonaFileText({ path: '/personas/lin-lan/persona.md', text: serialized })).toEqual(parsed);
  });

  it('rejects invalid delivery, memory, id, and empty body', () => {
    expect(() => parsePersonaFileText({ path: '/personas/lin-lan/persona.md', text: '---\nname: Lin\ndelivery: stream\n---\nbody' })).toThrow(/delivery/);
    expect(() => parsePersonaFileText({ path: '/personas/lin-lan/persona.md', text: '---\nname: Lin\nmemory:\n  shared: [persona]\n---\nbody' })).toThrow(/global or workspace/);
    expect(() => parsePersonaFileText({ path: '/personas/not_valid/persona.md', text: '---\nname: Lin\n---\nbody' })).toThrow(/kebab-case/);
    expect(() => parsePersonaFileText({ path: '/personas/lin-lan/persona.md', text: '---\nname: Lin\n---\n' })).toThrow(/description body/);
  });
});
