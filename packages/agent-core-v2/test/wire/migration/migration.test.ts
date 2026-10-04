import { describe, expect, it } from 'vitest';

import {
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from '#/wire/migration/migration';

describe('wire record migrations', () => {
  it('upgrades only profile.bind permissions to 1.6 and preserves saved v1 provenance', () => {
    const decision = { version: 1, selectionKind: 'profile_file', requestedProfile: 'reviewer' };
    const bind = { type: 'profile.bind', profileName: 'reviewer', modelAlias: 'saved-model',
      systemPrompt: 'saved-prompt', subagents: [], dispatchDecision: decision };
    expect(migrateWireRecord(bind, resolveWireMigrations('1.5'))).toEqual({
      type: 'profile.bind', profileName: 'reviewer', modelAlias: 'saved-model', systemPrompt: 'saved-prompt',
      canSpawnSubagents: false, allowedSubagents: [], dispatchDecision: decision,
    });
    const unrelated = { type: 'tool.message', subagents: 'opaque-tool-data' };
    expect(migrateWireRecord(unrelated, resolveWireMigrations('1.5'))).toEqual(unrelated);
  });

  it('applies migrations in order', () => {
    const migrations: WireMigration[] = [
      {
        sourceVersion: '0.8',
        targetVersion: '0.9',
        migrateRecord: (record) => ({
          ...record,
          first: true,
        }),
      },
      {
        sourceVersion: '0.9',
        targetVersion: '1.0',
        migrateRecord: (record) => ({
          ...record,
          second: record['first'] === true,
        }),
      },
    ];

    expect(migrateWireRecord({ type: 'metadata' }, migrations)).toEqual({
      type: 'metadata',
      first: true,
      second: true,
    });
  });
});
