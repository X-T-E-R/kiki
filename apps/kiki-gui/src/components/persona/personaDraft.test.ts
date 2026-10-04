import type { PersonaDefinition } from '@kiki/protocol';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PERSONA_DRAFT,
  HOME_WORKSPACE_AUTO,
  definitionFromDraft,
  draftFromDefinition,
  homeWorkspaceChoiceOf,
  homeWorkspaceValueOf,
  memorySharedValueOf,
  personaIdFromName,
  validatePersonaDraft,
} from './personaDraft';

const WORKSPACES = [
  { id: 'wd_release_000000000000', root: 'C:/work/workshop' },
  { id: 'wd_docs_000000000000000', root: 'C:/work/docs-site' },
];

const imported = {
  id: 'lin-lan',
  name: '林岚',
  description: '负责发布节奏。',
  greeting: '我在。',
  greetings: ['第二句开场白'],
  tags: ['release'],
  profile: 'agent',
  memory: { shared: [] },
} as unknown as PersonaDefinition;

describe('personaDraft', () => {
  it('keeps fields the editor does not show when saving', () => {
    const draft = { ...draftFromDefinition(imported), job: '写发布说明' };
    const saved = definitionFromDraft(draft, imported) as unknown as Record<string, unknown>;
    expect(saved).toMatchObject({ id: 'lin-lan', job: '写发布说明', greetings: ['第二句开场白'], tags: ['release'] });
  });

  it('round-trips the alternate greetings, room greeting, tags and notes it now shows', () => {
    const base = { id: 'a-che', name: '阿澈', description: 'd' } as unknown as PersonaDefinition;
    const draft = {
      ...draftFromDefinition(base),
      greetings: '第一句\n\n第二句',
      roomGreeting: '  在房间里我先听  ',
      tags: 'writing, 改稿,',
      notes: '只在项目对话里用',
    };
    expect(definitionFromDraft(draft, base)).toMatchObject({
      greetings: ['第一句', '第二句'],
      roomGreeting: '在房间里我先听',
      tags: ['writing', '改稿'],
      notes: '只在项目对话里用',
    });
    // Clearing them drops the keys instead of writing empty lists.
    const cleared = definitionFromDraft({ ...draft, greetings: '', roomGreeting: ' ', tags: '', notes: '' }, base);
    expect(cleared).not.toHaveProperty('greetings');
    expect(cleared).not.toHaveProperty('roomGreeting');
    expect(cleared).not.toHaveProperty('tags');
    expect(cleared).not.toHaveProperty('notes');
  });

  it('keeps a half-set memory policy instead of collapsing it to a boolean', () => {
    expect(memorySharedValueOf(['global', 'workspace'])).toBeUndefined();
    expect(memorySharedValueOf([])).toEqual({ shared: [] });
    expect(memorySharedValueOf(['global'])).toEqual({ shared: ['global'] });
    expect(memorySharedValueOf(['workspace'])).toEqual({ shared: ['workspace'] });

    const half = definitionFromDraft({ ...EMPTY_PERSONA_DRAFT, id: 'a', name: 'A', description: 'd', memoryShared: ['global'] });
    expect(half.memory).toEqual({ shared: ['global'] });
    // Reading it back keeps exactly one scope selected.
    expect(draftFromDefinition(half).memoryShared).toEqual(['global']);
    expect(draftFromDefinition({ ...half, memory: undefined }).memoryShared).toEqual(['global', 'workspace']);
  });

  it('maps the default workspace choice to the workspace root, and reads both spellings back', () => {
    expect(homeWorkspaceValueOf('ws:wd_docs_000000000000000', WORKSPACES)).toBe('C:/work/docs-site');
    expect(homeWorkspaceValueOf(HOME_WORKSPACE_AUTO, WORKSPACES)).toBeUndefined();
    expect(homeWorkspaceValueOf('path:C:/elsewhere/repo', WORKSPACES)).toBe('C:/elsewhere/repo');

    // A stored root selects that workspace; a trailing separator still matches.
    expect(homeWorkspaceChoiceOf('C:/work/workshop', WORKSPACES)).toBe('ws:wd_release_000000000000');
    expect(homeWorkspaceChoiceOf('C:/work/workshop/', WORKSPACES)).toBe('ws:wd_release_000000000000');
    // The older editor wrote a workspace id here; it reads back as that workspace.
    expect(homeWorkspaceChoiceOf('wd_docs_000000000000000', WORKSPACES)).toBe('ws:wd_docs_000000000000000');
    // A directory that is not a registered workspace stays itself: the editor
    // edits and saves it exactly as stored rather than gating it on registration.
    expect(homeWorkspaceChoiceOf('C:/elsewhere/repo', WORKSPACES)).toBe('path:C:/elsewhere/repo');

    // A choice whose workspace is gone is written through unchanged, never silently dropped.
    expect(homeWorkspaceValueOf('ws:wd_missing_0000000000', WORKSPACES)).toBe('wd_missing_0000000000');

    // Saving maps the picker's id to the real root and drops it for "automatic".
    const base = { id: 'a', name: 'A', description: 'd' } as unknown as PersonaDefinition;
    expect(definitionFromDraft({ ...EMPTY_PERSONA_DRAFT, id: 'a', name: 'A', description: 'd', homeWorkspace: 'ws:wd_docs_000000000000000' }, base, WORKSPACES))
      .toMatchObject({ homeWorkspace: 'C:/work/docs-site' });
    expect(definitionFromDraft({ ...EMPTY_PERSONA_DRAFT, id: 'a', name: 'A', description: 'd' }, base, WORKSPACES))
      .not.toHaveProperty('homeWorkspace');
  });

  it('keeps case-sensitive POSIX homes and unchanged stored roots', () => {
    const workspaces = [{ id: 'other', root: '/srv/project' }];
    const base = { id: 'a', name: 'A', description: 'd', homeWorkspace: '/srv/Project' } as PersonaDefinition;
    const draft = { ...draftFromDefinition(base, workspaces), title: 'Updated' };
    expect(draft.homeWorkspace).toBe('path:/srv/Project');
    expect(definitionFromDraft(draft, base, workspaces).homeWorkspace).toBe('/srv/Project');
    expect(definitionFromDraft({ ...draft, homeWorkspace: 'ws:other' }, base, workspaces).homeWorkspace).toBe('/srv/project');
  });

  it('recognizes Windows and UNC equivalents without rewriting an unchanged home', () => {
    const workspaces = [{ id: 'drive', root: 'c:/work/project' }, { id: 'unc', root: '//server/share/project' }];
    for (const [root, id] of [['C:\\Work\\Project\\', 'drive'], ['\\\\SERVER\\Share\\Project\\', 'unc']] as const) {
      const base = { id: 'a', name: 'A', description: 'd', homeWorkspace: root } as PersonaDefinition;
      const draft = { ...draftFromDefinition(base, workspaces), title: 'Updated' };
      expect(draft.homeWorkspace).toBe(`ws:${id}`);
      expect(definitionFromDraft(draft, base, workspaces).homeWorkspace).toBe(root);
    }
  });

  it('does not redirect a selected workspace if its registered root changes', () => {
    const base = { id: 'a', name: 'A', description: 'd', homeWorkspace: '/srv/Project' } as PersonaDefinition;
    const draft = draftFromDefinition(base, [{ id: 'project', root: '/srv/Project' }]);
    expect(definitionFromDraft({ ...draft, title: 'Updated' }, base, [{ id: 'project', root: '/srv/project' }]).homeWorkspace).toBe('/srv/Project');
  });

  it('drops blank optional fields instead of sending empty strings', () => {
    const saved = definitionFromDraft({ ...EMPTY_PERSONA_DRAFT, id: 'a', name: ' A ', description: 'd', title: '  ', greeting: ' ' });
    expect(saved).toEqual({ id: 'a', name: 'A', description: 'd' });
  });

  it('derives an id from the name, with a random suffix for non-ASCII names', () => {
    expect(personaIdFromName('Orin Hale')).toBe('orin-hale');
    expect(personaIdFromName('林岚', () => 'a1b2c3')).toBe('persona-a1b2c3');
  });

  it('validates required fields, and the id only while creating', () => {
    const blank = { ...EMPTY_PERSONA_DRAFT, id: 'Bad Id' };
    expect(validatePersonaDraft(blank, { creating: true })).toEqual({ name: 'nameRequired', description: 'descriptionRequired', id: 'idInvalid' });
    expect(validatePersonaDraft({ ...blank, id: 'taken', name: 'n', description: 'd' }, { creating: true, takenIds: new Set(['taken']) })).toEqual({ id: 'idTaken' });
    expect(validatePersonaDraft({ ...blank, name: 'n', description: 'd' }, { creating: false })).toEqual({});
  });
});
