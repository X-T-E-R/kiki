import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'smol-toml';
import { ConfigRegistry } from '#/app/config/configService';
import { applySectionToToml, transformTomlData } from '#/app/config/toml';
import { LOOP_CONTROL_SECTION, LoopControlSchema, loopControlFromToml, loopControlToToml } from '#/agent/loop/configSection';
import { memoryMaintenanceCandidate } from '#/session/todo/memoryCadence';
import { initialContinuityClock } from '#/session/todo/continuityState';

const registry = new ConfigRegistry();
afterAll(() => registry.dispose());

function load(text: string) {
  return LoopControlSchema.parse(transformTomlData(parse(text), registry)[LOOP_CONTROL_SECTION]);
}

describe('loop control TOML adapter', () => {
  it('round-trips every cadence field and adjacent loop settings in their real TOML shape', () => {
    const value = load('[loop_control]\nmax_steps_per_turn = 0\nmax_attempts_per_step = 3\nmax_ralph_iterations = -1\nreserved_context_size = 2048\ncontext_strategy = "fresh"\nsubagent_context_strategy = "auto"\nrelay_shadow = false\nauto_compact = "85%"\ncompaction_trigger_ratio = 0.8\ncompaction_max_attempts = 2\ncompaction_soft_context_size = 4096\n[loop_control.continuity_cadence]\nage_human_turns = 7\ncooldown_human_turns = 9\nlong_task_steps = 25\nmemory_maintenance = false\n[loop_control.directive_cues]\ninstructions = ["retain_rules"]\nhistory = ["review_history"]\n');
    expect(value.continuityCadence).toEqual({ ageHumanTurns: 7, cooldownHumanTurns: 9, longTaskSteps: 25, memoryMaintenance: false });
    expect(value.directiveCues).toEqual({ instructions: ['retain_rules'], history: ['review_history'] });
    expect(value).toMatchObject({ maxStepsPerTurn: 0, maxAttemptsPerStep: 3, maxRalphIterations: -1,
      reservedContextSize: 2048, contextStrategy: 'fresh', subagentContextStrategy: 'auto', relayShadow: false,
      autoCompact: '85%', compactionTriggerRatio: 0.8, compactionMaxAttempts: 2, compactionSoftContextSize: 4096 });
    const raw: Record<string, unknown> = {};
    applySectionToToml(raw, LOOP_CONTROL_SECTION, value, registry);
    expect(raw['loop_control']).toMatchObject({ continuity_cadence: { age_human_turns: 7, cooldown_human_turns: 9, long_task_steps: 25, memory_maintenance: false },
      directive_cues: { instructions: ['retain_rules'], history: ['review_history'] }, max_steps_per_turn: 0, relay_shadow: false });
    expect(load(stringify(raw))).toEqual(value);
  });

  it.each(['', '\n[loop_control.continuity_cadence]\nage_human_turns = 6'])('keeps an omitted memory switch default-on without writing a synthetic value (%s)', (nested) => {
    const value = load(`[loop_control]${nested}\n`);
    expect(value.continuityCadence?.memoryMaintenance).toBeUndefined();
    const raw: Record<string, unknown> = {};
    applySectionToToml(raw, LOOP_CONTROL_SECTION, value, registry);
    expect(stringify(raw)).not.toContain('memory_maintenance');
    const offer = memoryMaintenanceCandidate({ clock: { ...initialContinuityClock(), humanTurnOrdinal: 12, workStepOrdinal: 24 },
      epoch: 0, available: true, active: true, periodic: value.continuityCadence?.memoryMaintenance !== false, nearWindow: false, directive: false });
    expect(offer?.reason).toBe('M3');
  });

  it('preserves explicit false through serialization so periodic maintenance is disabled', () => {
    const value = load('[loop_control.continuity_cadence]\nmemory_maintenance = false\n');
    const raw: Record<string, unknown> = {};
    applySectionToToml(raw, LOOP_CONTROL_SECTION, value, registry);
    const reloaded = load(stringify(raw));
    expect(reloaded.continuityCadence?.memoryMaintenance).toBe(false);
    expect(memoryMaintenanceCandidate({ clock: { ...initialContinuityClock(), humanTurnOrdinal: 12, workStepOrdinal: 24 },
      epoch: 0, available: true, active: true, periodic: reloaded.continuityCadence?.memoryMaintenance !== false, nearWindow: false, directive: false })).toBeUndefined();
  });

  it('preserves unrelated raw keys and replaces nested known values without camelCase leakage', () => {
    const raw = { future_option: 'keep', continuity_cadence: { age_human_turns: 6, future_option: 'keep', memory_maintenance: true }, directive_cues: { history: ['old'], future_option: 'keep' } };
    expect(loopControlToToml({ continuityCadence: { ageHumanTurns: 7, memoryMaintenance: false }, directiveCues: { history: ['new'] } }, raw)).toEqual({
      future_option: 'keep', continuity_cadence: { age_human_turns: 7, future_option: 'keep', memory_maintenance: false }, directive_cues: { history: ['new'], future_option: 'keep' },
    });
    expect(raw.continuity_cadence.memory_maintenance).toBe(true);
  });

  it.each([null, false, [], 'invalid'])('leaves malformed section values for schema validation (%s)', (value) => {
    expect(loopControlFromToml(value)).toBe(value);
    expect(loopControlToToml(value, undefined)).toBe(value);
    expect(LoopControlSchema.safeParse(loopControlFromToml(value)).success).toBe(false);
  });
});
