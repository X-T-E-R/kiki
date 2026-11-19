import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const persistenceMiniDbReadModelFlag: FlagDefinitionInput = {
  id: 'persistence_minidb_readmodel',
  title: 'SQLite read model',
  description:
    'Use the SQLite-backed IQueryStore as a derived read model for session indexing and wire replay.',
  env: 'KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL',
  default: true,
  surface: 'core',
};

registerFlagDefinition(persistenceMiniDbReadModelFlag);
