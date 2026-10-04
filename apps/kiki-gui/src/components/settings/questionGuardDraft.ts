/**
 * Presenting the AskUserQuestion frequency guard in minutes.
 *
 * The guard's rules are not here. `questionGuardSettings` in session-core owns
 * the draft shape, the wire conversion, the sparse patch and the empty-value
 * meaning "inherit"; this file only decides how those values sit on screen:
 * which rows exist, what their bounds are, and that the window is shown in
 * minutes rather than milliseconds.
 *
 * That split is why the window is converted here instead of in the editor.
 * The stored value is a millisecond count because that is what the engine
 * counts in, but a person pacing their own questions thinks in minutes, and
 * nobody should be asked to type `600000`. The conversion is the one place
 * the two scales meet, so it is the one place worth testing.
 */

import {
  DEFAULT_ASK_USER_QUESTION_GUARD,
  resolveAskUserQuestionGuard,
  type AskUserQuestionGuardConfig,
} from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import {
  questionGuardConfigFromDraft,
  questionGuardDraftFromBehavior,
  questionGuardDraftFromConfig,
  questionGuardGlobalPatch,
  questionGuardModelPatch,
  type QuestionGuardDraft,
} from '@kiki/session-core/settings/questionGuardSettings';

export type { QuestionGuardDraft };
export type GuardEnabledChoice = QuestionGuardDraft['enabled'];
export {
  questionGuardConfigFromDraft,
  questionGuardDraftFromBehavior,
  questionGuardDraftFromConfig,
  questionGuardGlobalPatch,
  questionGuardModelPatch,
};

/** The empty draft: every field inheriting, which is what an untouched model holds. */
export const EMPTY_GUARD_DRAFT: QuestionGuardDraft = {
  enabled: 'inherit',
  maxPerUserRound: '',
  maxPerWindow: '',
  windowMs: '',
};

const MINUTE_MS = 60_000;
/** The shortest window a person can express in minutes. */
const MIN_WINDOW_MINUTES = 0.01;
/** A day, which is the engine's own ceiling read in minutes. */
const MAX_WINDOW_MINUTES = 1440;

export type GuardNumberKey = 'maxPerUserRound' | 'maxPerWindow' | 'windowMinutes';

/** One row of the guard, with the draft key it edits and the wire field it stores. */
export interface GuardNumberField {
  readonly key: GuardNumberKey;
  /** The `QuestionGuardDraft` key this row edits. The window's display unit
   *  gives it a different name from the draft's millisecond one. */
  readonly draftKey: 'maxPerUserRound' | 'maxPerWindow' | 'windowMs';
  readonly wire: 'max_per_user_round' | 'max_per_window' | 'window_ms';
  readonly label: I18nKey;
  readonly help: I18nKey;
  /** Bounds in the field's own unit. */
  readonly min: number;
  readonly max: number;
  /** Stored in milliseconds, edited in minutes. */
  readonly minutes: boolean;
  /** Text the field accepts; the window needs the decimals a short one takes. */
  readonly pattern: RegExp;
}

export const GUARD_NUMBER_FIELDS: readonly GuardNumberField[] = [
  {
    key: 'maxPerUserRound', draftKey: 'maxPerUserRound', wire: 'max_per_user_round',
    label: 'st.questionGuard.perRound', help: 'st.questionGuard.perRoundHelp',
    min: 1, max: 1000, minutes: false, pattern: /^\d+$/,
  },
  {
    key: 'maxPerWindow', draftKey: 'maxPerWindow', wire: 'max_per_window',
    label: 'st.questionGuard.perWindow', help: 'st.questionGuard.perWindowHelp',
    min: 1, max: 1000, minutes: false, pattern: /^\d+$/,
  },
  {
    key: 'windowMinutes', draftKey: 'windowMs', wire: 'window_ms',
    label: 'st.questionGuard.window', help: 'st.questionGuard.windowHelp',
    min: MIN_WINDOW_MINUTES, max: MAX_WINDOW_MINUTES, minutes: true, pattern: /^\d+(\.\d{1,2})?$/,
  },
];

/**
 * A stored window as minutes, at the precision a person reads back.
 *
 * The draft itself keeps the official millisecond value, exactly as
 * `questionGuardSettings` stores it, so a save never has to know that the
 * screen speaks a different unit. The conversion happens on the way in and on
 * the way out of the text box and nowhere else, which is what keeps a stored
 * `600000` and a typed `10` from each other.
 */
export function windowMsToMinutes(ms: number): string {
  const value = ms / MINUTE_MS;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** Minutes as the millisecond count the engine stores. */
export function minutesToWindowMs(text: string): number {
  return Math.round(Number(text.trim()) * MINUTE_MS);
}

/**
 * The value a field's *display* text means, or undefined when the text is not
 * a value this field can hold. Bounds are the engine's own, restated in the
 * field's own unit, so an out-of-range value is refused here for the same
 * reason it would be refused on the wire.
 */
export function guardNumberValue(field: GuardNumberField, text: string): number | undefined {
  const trimmed = text.trim();
  if (!field.pattern.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (value < field.min || value > field.max) return undefined;
  return field.minutes ? minutesToWindowMs(trimmed) : value;
}

/** What the row shows for a field: the stored ms read back into its own unit. */
export function guardDisplayValue(field: GuardNumberField, stored: string): string {
  const trimmed = stored.trim();
  if (trimmed === '') return '';
  return field.minutes ? windowMsToMinutes(Number(trimmed)) : trimmed;
}

export function guardDraftFromGlobalConfig(stored: AskUserQuestionGuardConfig | undefined): QuestionGuardDraft {
  return questionGuardDraftFromConfig(stored);
}

/**
 * The global card's draft. There is nothing above the global layer, so a field
 * the server does not report has nothing to inherit and the engine's own
 * default is what the box shows. This is why the global card offers no "clear"
 * control: clearing a global field would not restore the default, it would
 * only remove a value the next save would write straight back.
 */
export function guardDraftFromGlobalEffective(global: AskUserQuestionGuardConfig | undefined): QuestionGuardDraft {
  return questionGuardDraftFromConfig(resolveAskUserQuestionGuard(global, undefined));
}

export function guardDraftFromModelBehavior(behavior: Parameters<typeof questionGuardDraftFromBehavior>[0]): QuestionGuardDraft {
  return questionGuardDraftFromBehavior(behavior);
}

export function guardDraftsEqual(a: QuestionGuardDraft, b: QuestionGuardDraft): boolean {
  return a.enabled === b.enabled
    && a.maxPerUserRound === b.maxPerUserRound
    && a.maxPerWindow === b.maxPerWindow
    && a.windowMs === b.windowMs;
}

/**
 * The draft after a box is committed, from the text the person typed. Invalid
 * text is stored as typed so the field can show what is wrong with it; the
 * save path refuses it before anything reaches the wire.
 */
export function setGuardNumber(draft: QuestionGuardDraft, field: GuardNumberField, text: string): QuestionGuardDraft {
  const trimmed = text.trim();
  const value = trimmed === '' ? '' : String(guardNumberValue(field, trimmed) ?? trimmed);
  return { ...draft, [field.draftKey]: value };
}

export function clearGuardNumber(draft: QuestionGuardDraft, field: GuardNumberField): QuestionGuardDraft {
  return { ...draft, [field.draftKey]: '' };
}

/**
 * The first field whose text cannot be saved, so the caller can keep the whole
 * save off the wire rather than sending a valid patch beside a broken field.
 */
export function guardDraftProblem(
  draft: QuestionGuardDraft,
  rangeText: (field: GuardNumberField) => string,
): { field: GuardNumberField; text: string } | null {
  for (const field of GUARD_NUMBER_FIELDS) {
    const text = guardDisplayValue(field, draft[field.draftKey]).trim();
    if (draft[field.draftKey].trim() === '') continue;
    if (guardNumberValue(field, text) === undefined) return { field, text: rangeText(field) };
  }
  return null;
}

/**
 * What the model will actually get, from the engine's resolver over the draft.
 *
 * The resolver reads the model side off `behavior.askUserQuestionGuard`, so
 * the guard is handed over wrapped. Passing the bare guard would resolve to
 * the global layer for every field and quietly report a model that overrides
 * nothing as inheriting everything, which is the one mistake this display
 * cannot make.
 */
export function guardEffective(
  globalStored: AskUserQuestionGuardConfig | undefined,
  draft: QuestionGuardDraft,
): Required<AskUserQuestionGuardConfig> {
  return resolveAskUserQuestionGuard(globalStored, { askUserQuestionGuard: questionGuardConfigFromDraft(draft) });
}

/** Where an inheriting field's value comes from, so the row can say so. */
export type GuardSource = 'default' | 'global';

export interface GuardInheritedValue {
  readonly source: GuardSource;
  readonly text: string;
}

export function guardInherited(
  field: GuardNumberField,
  globalStored: AskUserQuestionGuardConfig | undefined,
  draft: QuestionGuardDraft,
): GuardInheritedValue | undefined {
  if (draft[field.draftKey].trim() !== '') return undefined;
  const effective = guardEffective(globalStored, draft);
  if (field.wire === 'window_ms') {
    return { source: globalStored?.windowMs === undefined ? 'default' : 'global', text: windowMsToMinutes(effective.windowMs) };
  }
  const key = field.draftKey;
  return { source: globalStored?.[key] === undefined ? 'default' : 'global', text: String(effective[key]) };
}

export { DEFAULT_ASK_USER_QUESTION_GUARD as GUARD_DEFAULTS };
