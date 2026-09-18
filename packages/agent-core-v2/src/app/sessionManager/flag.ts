import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SESSION_IDLE_EVICTION_FLAG_ID = 'session_idle_eviction';

export const sessionIdleEvictionFlag: FlagDefinitionInput = {
  id: SESSION_IDLE_EVICTION_FLAG_ID,
  title: 'session idle eviction',
  description: 'Unload eligible idle session runtimes while preserving their durable history.',
  env: 'KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION',
  default: false,
  surface: 'core',
};

registerFlagDefinition(sessionIdleEvictionFlag);
