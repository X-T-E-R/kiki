/**
 * `subagent` domain — registers the `secondary-model` experimental flag
 * into `flag`.
 *
 * Gates the legacy symbolic primary/secondary selector, secondary recipe,
 * and recipe validation warning. Exact aliases, thinking effort, and
 * `[subagent]` defaults are flag-independent. Off by default; enable via the
 * per-feature env, master env, or `[experimental]` config section.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SECONDARY_MODEL_FLAG_ID = 'secondary-model';
export const SECONDARY_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL';

export const secondaryModelFlag: FlagDefinitionInput = {
  id: SECONDARY_MODEL_FLAG_ID,
  title: 'Secondary subagent model',
  description:
    'Let newly spawned subagents use the legacy primary/secondary selector and configured secondary-model recipe.',
  env: SECONDARY_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(secondaryModelFlag);
