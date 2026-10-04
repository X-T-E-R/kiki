import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { cloneRecord, isPlainObject, plainObjectToToml, transformPlainObject } from '#/app/config/toml';

export const LOOP_CONTROL_SECTION = 'loopControl';

export const LOOP_MAX_STEPS_PER_TURN_ENV = 'KIKI_LOOP_MAX_STEPS_PER_TURN';
export const LOOP_MAX_ATTEMPTS_PER_STEP_ENV = 'KIKI_LOOP_MAX_ATTEMPTS_PER_STEP';
export const LOOP_COMPACTION_SOFT_CONTEXT_SIZE_ENV =
  'KIKI_LOOP_COMPACTION_SOFT_CONTEXT_SIZE';
export const DEFAULT_COMPACTION_SOFT_CONTEXT_SIZE = 0;

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxAttemptsPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  contextStrategy: z.enum(['summarize', 'auto', 'fresh']).optional(),
  subagentContextStrategy: z.enum(['summarize', 'auto', 'fresh']).optional(),
  relayShadow: z.boolean().optional(),
  continuityCadence: z.object({
    ageHumanTurns: z.number().int().min(1).optional(),
    cooldownHumanTurns: z.number().int().min(1).optional(),
    longTaskSteps: z.number().int().min(1).optional(),
    memoryMaintenance: z.boolean().optional(),
  }).optional(),
  directiveCues: z.object({
    instructions: z.array(z.string().min(1).max(100)).max(100).optional(),
    history: z.array(z.string().min(1).max(100)).max(100).optional(),
  }).optional(),
  autoCompact: z.string({ error: 'global loop_control.auto_compact must be a percentage such as "85%"; token counts belong at model, profile, or session level' })
    .regex(/^(?:100(?:\.0+)?|(?:[1-9]?\d)(?:\.\d+)?)%$/, 'global loop_control.auto_compact must be a percentage such as "85%"; token counts belong at model, profile, or session level')
    .optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
  compactionMaxAttempts: z.number().int().min(1).optional(),
  compactionSoftContextSize: z.number().int().min(0).optional(),
});

export type LoopControl = z.infer<typeof LoopControlSchema>;

function parseNonNegativeInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const loopControlEnvBindings: EnvBindings<LoopControl> = envBindings(LoopControlSchema, {
  maxStepsPerTurn: { env: LOOP_MAX_STEPS_PER_TURN_ENV, parse: parseNonNegativeInt },
  maxAttemptsPerStep: {
    env: LOOP_MAX_ATTEMPTS_PER_STEP_ENV,
    parse: parseNonNegativeInt,
  },
  compactionSoftContextSize: {
    env: LOOP_COMPACTION_SOFT_CONTEXT_SIZE_ENV,
    parse: parseNonNegativeInt,
  },
});

export const stripLoopControlEnv = stripEnvBoundFields(loopControlEnvBindings);

export const loopControlFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const value = transformPlainObject(rawSnake);
  for (const key of ['continuityCadence', 'directiveCues']) {
    const nested = value[key];
    if (isPlainObject(nested)) value[key] = transformPlainObject(nested);
  }
  return value;
};

export const loopControlToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out = plainObjectToToml(value, rawSnake);
  const raw = cloneRecord(rawSnake);
  for (const [key, snakeKey] of [['continuityCadence', 'continuity_cadence'], ['directiveCues', 'directive_cues']] as const) {
    const nested = value[key];
    if (isPlainObject(nested)) out[snakeKey] = plainObjectToToml(nested, raw[snakeKey]);
  }
  return out;
};

registerConfigSection(LOOP_CONTROL_SECTION, LoopControlSchema, {
  defaultValue: { compactionSoftContextSize: DEFAULT_COMPACTION_SOFT_CONTEXT_SIZE },
  fromToml: loopControlFromToml,
  toToml: loopControlToToml,
  env: loopControlEnvBindings,
  stripEnv: stripLoopControlEnv,
});
