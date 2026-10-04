/**
 * The guard as the editor shows it: what an untouched model writes, what a
 * single override sends, what clearing sends, which values are refused, and
 * where a minute-valued window lands on the wire.
 *
 * The rules under test come from session-core's `questionGuardSettings`; what
 * this file pins down is the presentation layer on top of it — the minute
 * conversion in particular, which is the only place the two scales meet.
 */

import { describe, expect, it } from 'vitest';

import {
  GUARD_DEFAULTS,
  GUARD_NUMBER_FIELDS,
  clearGuardNumber,
  guardDisplayValue,
  guardDraftFromGlobalConfig,
  guardDraftFromGlobalEffective,
  guardDraftFromModelBehavior,
  guardDraftProblem,
  guardEffective,
  guardInherited,
  guardNumberValue,
  minutesToWindowMs,
  questionGuardConfigFromDraft,
  questionGuardGlobalPatch,
  questionGuardModelPatch,
  setGuardNumber,
  windowMsToMinutes,
  type GuardNumberField,
  type QuestionGuardDraft,
} from './questionGuardDraft';

const range = (): string => 'out of range';
const field = (key: string): GuardNumberField => GUARD_NUMBER_FIELDS.find((entry) => entry.key === key)!;

const EMPTY: QuestionGuardDraft = { enabled: 'inherit', maxPerUserRound: '', maxPerWindow: '', windowMs: '' };
const draft = (overrides: Partial<QuestionGuardDraft> = {}): QuestionGuardDraft => ({ ...EMPTY, ...overrides });
/**
 * The draft after a person types into the three boxes. The window is given in
 * minutes because that is what the box shows, and lands in the draft as the
 * millisecond count the engine stores.
 */
const shown = (values: { perRound?: string; perWindow?: string; window?: string; enabled?: QuestionGuardDraft['enabled'] }): QuestionGuardDraft =>
  setGuardNumber(
    setGuardNumber(
      setGuardNumber(draft({ enabled: values.enabled ?? 'inherit' }), field('maxPerUserRound'), values.perRound ?? ''),
      field('maxPerWindow'),
      values.perWindow ?? '',
    ),
    field('windowMinutes'),
    values.window ?? '',
  );

describe('the stored defaults', () => {
  it('are off, one per round, three per ten minutes', () => {
    expect(GUARD_DEFAULTS).toEqual({ enabled: false, maxPerUserRound: 1, maxPerWindow: 3, windowMs: 600_000 });
  });

  it('reach the global screen with no stored values at all', () => {
    const shownDraft = guardDraftFromGlobalEffective(undefined);
    expect(shownDraft).toEqual({ enabled: 'off', maxPerUserRound: '1', maxPerWindow: '3', windowMs: '600000' });
    expect(guardDisplayValue(field('windowMinutes'), shownDraft.windowMs)).toBe('10');
  });

  it('read a stored window back in minutes rather than milliseconds', () => {
    expect(guardDisplayValue(field('windowMinutes'), guardDraftFromGlobalConfig({ windowMs: 600_000 }).windowMs)).toBe('10');
    expect(guardDisplayValue(field('windowMinutes'), guardDraftFromGlobalConfig({ windowMs: 90_000 }).windowMs)).toBe('1.5');
  });
});

describe('a model that has never been touched', () => {
  it('reads as fully inheriting, from either an absent or an empty behavior', () => {
    expect(guardDraftFromModelBehavior(undefined)).toEqual(EMPTY);
    expect(guardDraftFromModelBehavior({})).toEqual(EMPTY);
  });

  it('writes no override at all, so opening and saving changes nothing', () => {
    expect(questionGuardModelPatch(EMPTY, EMPTY)).toBeUndefined();
    expect(questionGuardGlobalPatch(EMPTY, EMPTY)).toBeUndefined();
    expect(questionGuardConfigFromDraft(EMPTY)).toEqual({});
  });
});

describe('a single field override on a model', () => {
  it('sends only that field, leaving the other three inheriting', () => {
    expect(questionGuardModelPatch(shown({ perRound: '2' }), EMPTY)).toEqual({ ask_user_question_guard: { max_per_user_round: 2 } });
  });

  it('inherits the other fields from the global layer', () => {
    const next = shown({ perRound: '2' });
    expect(guardEffective({ enabled: true, maxPerWindow: 9, windowMs: 60_000 }, next)).toEqual({
      enabled: true, maxPerUserRound: 2, maxPerWindow: 9, windowMs: 60_000,
    });
  });

  it('keeps an explicit off instead of inheriting the global on', () => {
    const next = draft({ enabled: 'off' });
    expect(questionGuardModelPatch(next, EMPTY)).toEqual({ ask_user_question_guard: { enabled: false } });
    expect(guardEffective({ enabled: true, maxPerWindow: 5 }, next).enabled).toBe(false);
  });
});

describe('clearing one override on a model', () => {
  it('sends null for that field alone and keeps the others', () => {
    const stored = guardDraftFromModelBehavior({ ask_user_question_guard: { enabled: true, max_per_user_round: 2, max_per_window: 4 } });
    const next = clearGuardNumber(stored, field('maxPerUserRound'));
    expect(questionGuardModelPatch(next, stored)).toEqual({ ask_user_question_guard: { max_per_user_round: null } });
  });

  it('goes back to the global value after the clear', () => {
    expect(guardEffective({ maxPerUserRound: 6 }, draft()).maxPerUserRound).toBe(6);
  });
});

describe('the global patch', () => {
  it('nests the guard under interaction and sends only what moved', () => {
    const before = guardDraftFromGlobalEffective(undefined);
    const after = setGuardNumber(before, field('maxPerWindow'), '5');
    expect(questionGuardGlobalPatch(after, before)).toEqual({ ask_user_question_guard: { max_per_window: 5 } });
  });

  it('writes a back to the engine default when the global box is emptied', () => {
    const before = guardDraftFromGlobalEffective(undefined);
    const after = clearGuardNumber(before, field('maxPerUserRound'));
    expect(questionGuardGlobalPatch(after, before)).toEqual({ ask_user_question_guard: { max_per_user_round: 1 } });
  });
});

describe('the window, stored in milliseconds and edited in minutes', () => {
  it('converts both ways', () => {
    expect(minutesToWindowMs('10')).toBe(600_000);
    expect(minutesToWindowMs('0.5')).toBe(30_000);
    expect(windowMsToMinutes(600_000)).toBe('10');
    expect(windowMsToMinutes(90_000)).toBe('1.5');
  });

  it('puts minutes on the wire as the millisecond count', () => {
    expect(questionGuardModelPatch(shown({ window: '2.5' }), EMPTY)).toEqual({ ask_user_question_guard: { window_ms: 150_000 } });
  });

  it('round-trips a stored value back to the same wire number', () => {
    const display = guardDraftFromModelBehavior({ ask_user_question_guard: { window_ms: 150_000 } });
    expect(guardDisplayValue(field('windowMinutes'), display.windowMs)).toBe('2.5');
    expect(questionGuardModelPatch(display, EMPTY)).toEqual({ ask_user_question_guard: { window_ms: 150_000 } });
  });
});

describe('values the editor refuses', () => {
  it('rejects zero and negatives on a count', () => {
    expect(guardNumberValue(field('maxPerUserRound'), '0')).toBeUndefined();
    expect(guardNumberValue(field('maxPerUserRound'), '-1')).toBeUndefined();
  });

  it('rejects a count past the engine ceiling and a non-integer count', () => {
    expect(guardNumberValue(field('maxPerUserRound'), '1000')).toBe(1000);
    expect(guardNumberValue(field('maxPerUserRound'), '1001')).toBeUndefined();
    expect(guardNumberValue(field('maxPerUserRound'), '1.5')).toBeUndefined();
  });

  it('rejects an empty or non-numeric window, zero minutes, and a window past a day', () => {
    expect(guardNumberValue(field('windowMinutes'), '')).toBeUndefined();
    expect(guardNumberValue(field('windowMinutes'), '10m')).toBeUndefined();
    expect(guardNumberValue(field('windowMinutes'), '0')).toBeUndefined();
    expect(guardNumberValue(field('windowMinutes'), '1440')).toBe(86_400_000);
    expect(guardNumberValue(field('windowMinutes'), '1441')).toBeUndefined();
  });

  it('names the offending field so the row can show it', () => {
    expect(guardDraftProblem(shown({ perWindow: '0' }), range)?.field.key).toBe('maxPerWindow');
    expect(guardDraftProblem(shown({ perWindow: '0' }), range)?.text).toBe('out of range');
  });

  it('finds nothing wrong with a valid draft', () => {
    expect(guardDraftProblem(shown({ perRound: '2', perWindow: '5', window: '10' }), range)).toBeNull();
  });
});

describe('the provenance an inheriting model row shows', () => {
  it('is absent once the model sets the field', () => {
    expect(guardInherited(field('maxPerUserRound'), { maxPerUserRound: 5 }, shown({ perRound: '2' }))).toBeUndefined();
  });

  it('names the global layer when the global holds the value', () => {
    expect(guardInherited(field('maxPerUserRound'), { maxPerUserRound: 5 }, EMPTY)).toEqual({ source: 'global', text: '5' });
  });

  it('names the engine default when neither layer holds it', () => {
    expect(guardInherited(field('maxPerWindow'), { enabled: true }, EMPTY)).toEqual({ source: 'default', text: '3' });
  });

  it('reads an inherited window in minutes whatever layer it came from', () => {
    expect(guardInherited(field('windowMinutes'), undefined, EMPTY)).toEqual({ source: 'default', text: '10' });
    expect(guardInherited(field('windowMinutes'), { windowMs: 120_000 }, EMPTY)).toEqual({ source: 'global', text: '2' });
  });
});
