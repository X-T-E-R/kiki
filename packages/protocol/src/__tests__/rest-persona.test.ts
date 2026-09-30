import { describe, expect, it } from 'vitest';

import {
  PERSONA_AVATAR_MAX_BYTES,
  personaAvatarDataSchema,
  personaDefinitionSchema,
  personaExportQuerySchema,
  personaImportPreviewSchema,
  personaListQuerySchema,
  personaPutInputSchema,
  personaSnapshotSchema,
} from '../index';

const definition = {
  id: 'lin-lan',
  name: 'Lin Lan',
  title: 'Release coordinator',
  job: 'Keeps releases moving',
  profile: 'agent',
  modelAlias: 'sonnet',
  thinkingEffort: 'medium',
  greeting: 'I am here.',
  greetings: ['What are we shipping?'],
  roomGreeting: 'Ready for the room.',
  delivery: 'reply' as const,
  memory: { shared: ['global', 'workspace'] as const },
  skills: ['release-notes'],
  tags: ['work'],
  notes: 'Visible only in the editor.',
  homeWorkspace: 'C:/work/kiki',
  description: 'You coordinate releases.',
};

describe('persona REST protocol', () => {
  it('round-trips the frozen camelCase definition and snapshot shape', () => {
    expect(personaDefinitionSchema.parse(definition)).toEqual(definition);
    expect(personaSnapshotSchema.parse({ definition, revision: 'rev-1', examples: 'Q: hi' })).toMatchObject({
      definition,
      revision: 'rev-1',
    });
    expect(personaPutInputSchema.parse({ definition, revision: 'rev-0' }).definition.id).toBe('lin-lan');
  });

  it('coerces query booleans without treating false as true', () => {
    expect(personaListQuerySchema.parse({ includeArchived: 'true' })).toEqual({ includeArchived: true });
    expect(personaListQuerySchema.parse({ includeArchived: 'false' })).toEqual({ includeArchived: false });
    expect(personaExportQuerySchema.parse({})).toEqual({ format: 'json' });
  });

  it('keeps import preview complete and avatar fallback data minimal', () => {
    const preview = personaImportPreviewSchema.parse({
      format: 'json',
      definition,
      examples: 'Q: hi',
      memoryEntries: [{ title: 'User', body: 'Likes concise updates.', pinned: true, type: 'reference' }],
      ignoredFields: ['post_history_instructions'],
      extensions: { vendor: { key: 'value' } },
    });
    expect(preview.definition.description).toBe('You coordinate releases.');
    expect(personaAvatarDataSchema.parse({ id: 'lin-lan', name: 'Lin Lan' })).toEqual({ id: 'lin-lan', name: 'Lin Lan' });
    expect(PERSONA_AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
