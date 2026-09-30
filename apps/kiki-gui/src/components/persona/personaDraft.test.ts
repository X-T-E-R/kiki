import type { PersonaDefinition } from '@kiki/protocol';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PERSONA_DRAFT,
  definitionFromDraft,
  draftFromDefinition,
  personaIdFromName,
  validatePersonaDraft,
} from './personaDraft';

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

  it('spells "own memory only" as shared: [] and drops it for the default', () => {
    expect(draftFromDefinition(imported).memory).toBe('own');
    expect(definitionFromDraft({ ...draftFromDefinition(imported), memory: 'shared' }, imported)).not.toHaveProperty('memory');
    expect(definitionFromDraft({ ...EMPTY_PERSONA_DRAFT, id: 'a', name: 'A', description: 'd', memory: 'own' }).memory).toEqual({ shared: [] });
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
