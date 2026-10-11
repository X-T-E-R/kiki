import { translate, type I18nKey, type I18nParams, type Locale } from '../i18n/locale';

const MINUTE_MAX = 59;
const HOUR_MAX = 23;
const DAY_OF_MONTH_MAX = 31;
const MONTH_MAX = 12;
const DAY_OF_WEEK_MAX = 7;

export type CronTranslate = (key: I18nKey, params?: I18nParams) => string;

/** The repeat patterns the readable controls cover. */
export type CronCadence = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface CronForm {
  readonly cadence: CronCadence;
  /** Minute within the hour, 0-59. Every cadence reads it. */
  readonly minute: number;
  /** Hour of day, 0-23. Unused by `hourly`, which repeats across the day. */
  readonly hour: number;
  /** Hours between repeats for `hourly`; 1 is "every hour on the hour". */
  readonly hourStep: number;
  /** Selected days, 0 = Sunday. Meaningful for `weekly`. */
  readonly weekdays: readonly number[];
  /** Day of month, 1-31. Meaningful for `monthly`. */
  readonly dayOfMonth: number;
}

export interface ParsedCronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

export interface ParsedCron {
  readonly raw: string;
  readonly minutes: ParsedCronField;
  readonly hours: ParsedCronField;
  readonly daysOfMonth: ParsedCronField;
  readonly months: ParsedCronField;
  readonly daysOfWeek: ParsedCronField;
}

export type CronParseResult =
  | { readonly ok: true; readonly parsed: ParsedCron }
  | { readonly ok: false; readonly raw: string };

/**
 * The same grammar the engine accepts: five whitespace-separated fields,
 * each a comma list of `*`, `n` or `a-b` terms with an optional positive step,
 * with stepped bare values extending to the field maximum. Parsed
 * here so the GUI can speak about an expression without pulling the engine in.
 */
export function parseCron(raw: string): CronParseResult {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return { ok: false, raw: trimmed };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return { ok: false, raw: trimmed };
  const parsed = [
    parseField(fields[0] as string, 0, MINUTE_MAX),
    parseField(fields[1] as string, 0, HOUR_MAX),
    parseField(fields[2] as string, 1, DAY_OF_MONTH_MAX),
    parseField(fields[3] as string, 1, MONTH_MAX),
    parseField(fields[4] as string, 0, DAY_OF_WEEK_MAX),
  ] as const;
  if (parsed.some((field) => field === undefined)) return { ok: false, raw: trimmed };
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as [
    ParsedCronField,
    ParsedCronField,
    ParsedCronField,
    ParsedCronField,
    ParsedCronField,
  ];
  const normalizedWeekdays = new Set<number>();
  for (const day of daysOfWeek.values) normalizedWeekdays.add(day === 7 ? 0 : day);
  return {
    ok: true,
    parsed: {
      raw: trimmed,
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek: { values: normalizedWeekdays, wildcard: daysOfWeek.wildcard },
    },
  };
}

function parseField(field: string, min: number, max: number): ParsedCronField | undefined {
  if (field === '') return undefined;
  const values = new Set<number>();
  for (const term of field.split(',')) {
    if (term === '') return undefined;
    const [range, stepText, ...rest] = term.split('/');
    if (rest.length > 0) return undefined;
    const step = stepText === undefined ? 1 : parseDigits(stepText);
    if (step === undefined || step < 1) return undefined;
    const base = range === undefined ? undefined : parseRange(range, min, max, stepText !== undefined);
    if (base === undefined) return undefined;
    for (let value = base.start; value <= base.end; value += step) values.add(value);
  }
  if (values.size === 0) return undefined;
  return { values, wildcard: field === '*' };
}

function parseDigits(text: string): number | undefined {
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
}

function parseRange(
  text: string,
  min: number,
  max: number,
  hasStep: boolean,
): { readonly start: number; readonly end: number } | undefined {
  if (text === '*') return { start: min, end: max };
  const dash = text.indexOf('-');
  if (dash === -1) {
    const single = parseDigits(text);
    return single === undefined || single < min || single > max
      ? undefined
      : { start: single, end: hasStep ? max : single };
  }
  const start = parseDigits(text.slice(0, dash));
  const end = parseDigits(text.slice(dash + 1));
  if (start === undefined || end === undefined) return undefined;
  if (start < min || end > max || start > end) return undefined;
  return { start, end };
}

function formatFieldSet(values: ReadonlySet<number>): string {
  const sorted = [...values].toSorted((a, b) => a - b);
  if (sorted.length === 0) return '*';
  const parts: string[] = [];
  let runStart = sorted[0]!;
  let previous = sorted[0]!;
  for (const value of sorted.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    parts.push(runStart === previous ? `${runStart}` : `${runStart}-${previous}`);
    runStart = value;
    previous = value;
  }
  parts.push(runStart === previous ? `${runStart}` : `${runStart}-${previous}`);
  return parts.join(',');
}

function isFullRange(field: ParsedCronField, min: number, max: number): boolean {
  if (field.values.size !== max - min + 1) return false;
  for (let value = min; value <= max; value += 1) if (!field.values.has(value)) return false;
  return true;
}

function isSingle(field: ParsedCronField): number | undefined {
  if (field.values.size !== 1) return undefined;
  return [...field.values][0];
}

function stepOf(field: ParsedCronField, min: number, max: number): number | undefined {
  const sorted = [...field.values].toSorted((a, b) => a - b);
  if (sorted.length < 2 || sorted[0] !== min) return undefined;
  const step = sorted[1]! - min;
  if (step < 1) return undefined;
  let expected = min;
  for (const value of sorted) {
    if (value !== expected || value > max) return undefined;
    expected += step;
  }
  return expected > max ? step : undefined;
}

const WEEKDAY_KEYS = [
  'cron.schedule.day.sunday',
  'cron.schedule.day.monday',
  'cron.schedule.day.tuesday',
  'cron.schedule.day.wednesday',
  'cron.schedule.day.thursday',
  'cron.schedule.day.friday',
  'cron.schedule.day.saturday',
] as const satisfies readonly I18nKey[];

/**
 * The locale key naming a weekday, for callers that need to name one outside
 * `localizedCronSchedule` (the form's day chips). An out-of-range day falls
 * back to Sunday rather than producing a key that does not exist.
 */
export function weekdayKey(day: number): I18nKey {
  return WEEKDAY_KEYS[day] ?? WEEKDAY_KEYS[0];
}

const MONTH_KEYS = [
  'cron.schedule.month.january',
  'cron.schedule.month.february',
  'cron.schedule.month.march',
  'cron.schedule.month.april',
  'cron.schedule.month.may',
  'cron.schedule.month.june',
  'cron.schedule.month.july',
  'cron.schedule.month.august',
  'cron.schedule.month.september',
  'cron.schedule.month.october',
  'cron.schedule.month.november',
  'cron.schedule.month.december',
] as const satisfies readonly I18nKey[];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clockTimes(parsed: ParsedCron, t: CronTranslate): string | undefined {
  const minutes = [...parsed.minutes.values].toSorted((a, b) => a - b);
  const hours = [...parsed.hours.values].toSorted((a, b) => a - b);
  if (minutes.length === 0 || hours.length === 0) return undefined;
  if (hours.length === 1) {
    const hour = hours[0]!;
    return minutes.map((minute) => `${pad(hour)}:${pad(minute)}`).join(t('cron.schedule.times'));
  }
  if (minutes.length !== 1) return undefined;
  const minute = minutes[0]!;
  return hours.map((hour) => `${pad(hour)}:${pad(minute)}`).join(t('cron.schedule.times'));
}

const WEEKDAYS_SET = new Set([1, 2, 3, 4, 5]);
const WEEKEND_SET = new Set([0, 6]);

function weekdayName(t: CronTranslate, day: number): string {
  return t(weekdayKey(day));
}

function sameSet(field: ParsedCronField, expected: ReadonlySet<number>): boolean {
  if (field.values.size !== expected.size) return false;
  for (const value of expected) if (!field.values.has(value)) return false;
  return true;
}

/**
 * The readable name of an expression in the active locale, or `undefined`
 * when no shape covers it — in which case the caller keeps the engine's own
 * string rather than inventing a claim about the rule.
 */
export function localizedCronSchedule(
  locale: Locale,
  raw: string,
  t: CronTranslate = (key, params) => translate(locale, key, params),
): string | undefined {
  const result = parseCron(raw);
  if (!result.ok) return undefined;
  const parsed = result.parsed;
  const allHours = isFullRange(parsed.hours, 0, HOUR_MAX);
  const allMonths = isFullRange(parsed.months, 1, MONTH_MAX);
  const everyDay = parsed.daysOfMonth.wildcard && parsed.daysOfWeek.wildcard;

  if (everyDay && allMonths) {
    const minuteStep = stepOf(parsed.minutes, 0, MINUTE_MAX);
    if (allHours && minuteStep !== undefined && minuteStep > 1) {
      return t('cron.schedule.everyNMinutes', { n: minuteStep });
    }
    if (isFullRange(parsed.minutes, 0, MINUTE_MAX)) {
      return allHours ? t('cron.schedule.everyMinute') : undefined;
    }
    const hourStep = stepOf(parsed.hours, 0, HOUR_MAX);
    if (hourStep !== undefined && hourStep > 1) {
      const minute = isSingle(parsed.minutes);
      if (minute === undefined) return undefined;
      if (minute === 0) return t('cron.schedule.everyNHoursOnTheHour', { n: hourStep });
      return t('cron.schedule.everyNHours', { n: hourStep, m: minute });
    }
    if (!allHours) {
      const times = clockTimes(parsed, t);
      return times === undefined ? undefined : t('cron.schedule.daily', { times });
    }
    const minute = isSingle(parsed.minutes);
    if (minute === undefined) return undefined;
    if (minute === 0) return t('cron.schedule.hourlyOnTheHour');
    return t('cron.schedule.hourly', { m: minute });
  }

  const minute = isSingle(parsed.minutes);
  const hour = isSingle(parsed.hours);
  const dayOfMonth = isSingle(parsed.daysOfMonth);
  const month = isSingle(parsed.months);
  if (minute === undefined || hour === undefined) return undefined;

  const times = `${pad(hour)}:${pad(minute)}`;

  if (parsed.daysOfMonth.wildcard && allMonths) {
    if (parsed.daysOfWeek.wildcard) return t('cron.schedule.daily', { times });
    if (sameSet(parsed.daysOfWeek, WEEKDAYS_SET)) return t('cron.schedule.weekdays', { times });
    if (sameSet(parsed.daysOfWeek, WEEKEND_SET)) return t('cron.schedule.weekends', { times });
    const days = [...parsed.daysOfWeek.values].toSorted((a, b) => a - b);
    if (days.length === 0) return undefined;
    return t('cron.schedule.weekly', { days: days.map((day) => weekdayName(t, day)).join(t('cron.schedule.times')), times });
  }

  if (!parsed.daysOfMonth.wildcard && dayOfMonth !== undefined && allMonths) {
    if (parsed.daysOfWeek.wildcard) return t('cron.schedule.monthly', { day: dayOfMonth, times });
  }

  if (dayOfMonth !== undefined && month !== undefined && parsed.daysOfWeek.wildcard) {
    const monthLabel = locale === 'zh'
      ? String(month)
      : t(MONTH_KEYS[month - 1] ?? MONTH_KEYS[0]);
    return t('cron.schedule.yearly', { month: monthLabel, day: dayOfMonth, times });
  }

  return undefined;
}

/** The label for an expression, with the raw text as the last resort. */
export function cronScheduleLabel(
  locale: Locale,
  raw: string,
  fallback: string,
  t: CronTranslate = (key, params) => translate(locale, key, params),
): string {
  return localizedCronSchedule(locale, raw, t) ?? fallback;
}

export type CronFormRead =
  | { readonly kind: 'friendly'; readonly form: CronForm; readonly cron: string }
  /** A valid expression the readable controls cannot hold; `raw` is verbatim. */
  | { readonly kind: 'advanced'; readonly raw: string }
  /** Not a schedule the engine would accept; the form offers to fix it. */
  | { readonly kind: 'invalid'; readonly raw: string };

/**
 * An expression the controls can represent, or a reason they cannot.
 *
 * `advanced` is a first-class answer, not a failure: those rules keep their
 * exact text so opening and saving a complex task never quietly narrows it.
 */
export function readCronForm(raw: string): CronFormRead {
  const result = parseCron(raw);
  if (!result.ok) return { kind: 'invalid', raw };
  const parsed = result.parsed;
  const allMonths = isFullRange(parsed.months, 1, MONTH_MAX);
  const allDays = parsed.daysOfMonth.wildcard && parsed.daysOfWeek.wildcard;
  const minute = isSingle(parsed.minutes);
  if (minute === undefined) return { kind: 'advanced', raw };

  if (allDays && allMonths) {
    const hourStep = stepOf(parsed.hours, 0, HOUR_MAX);
    if (hourStep !== undefined && [1, 2, 3, 4, 6, 8, 12].includes(hourStep)) {
      return finish({ cadence: 'hourly', minute, hour: 0, hourStep, weekdays: [], dayOfMonth: 1 });
    }
    const hour = isSingle(parsed.hours);
    if (hour !== undefined) {
      return finish({ cadence: 'daily', minute, hour, hourStep: 1, weekdays: [], dayOfMonth: 1 });
    }
    return { kind: 'advanced', raw };
  }

  if (allMonths && !parsed.daysOfMonth.wildcard && minute !== undefined) {
    const hour = isSingle(parsed.hours);
    const day = isSingle(parsed.daysOfMonth);
    if (hour !== undefined && day !== undefined && parsed.daysOfWeek.wildcard) {
      return finish({ cadence: 'monthly', minute, hour, hourStep: 1, weekdays: [], dayOfMonth: day });
    }
    return { kind: 'advanced', raw };
  }

  if (
    allMonths
    && parsed.daysOfMonth.wildcard
    && !parsed.daysOfWeek.wildcard
    && minute !== undefined
    && parsed.daysOfWeek.values.size > 0
  ) {
    const hour = isSingle(parsed.hours);
    if (hour !== undefined) {
      return finish({
        cadence: 'weekly',
        minute,
        hour,
        hourStep: 1,
        weekdays: [...parsed.daysOfWeek.values].toSorted((a, b) => a - b),
        dayOfMonth: 1,
      });
    }
  }

  return { kind: 'advanced', raw };
}

function finish(form: CronForm): CronFormRead {
  return { kind: 'friendly', form, cron: writeCronForm(form) };
}

/** The expression a set of controls means, in the engine's own grammar. */
export function writeCronForm(form: CronForm): string {
  const minute = String(form.minute);
  if (form.cadence === 'hourly') {
    const hours = form.hourStep <= 1 ? '*' : `*/${form.hourStep}`;
    return `${minute} ${hours} * * *`;
  }
  const hours = String(form.hour);
  if (form.cadence === 'daily') return `${minute} ${hours} * * *`;
  if (form.cadence === 'weekly') {
    const days = form.weekdays.length === 0 ? 0 : formatFieldSet(new Set(form.weekdays));
    return `${minute} ${hours} * * ${days}`;
  }
  return `${minute} ${hours} ${form.dayOfMonth} * *`;
}

/** The controls a fresh task starts on. */
export const DEFAULT_CRON_FORM: CronForm = {
  cadence: 'daily',
  minute: 0,
  hour: 9,
  hourStep: 1,
  weekdays: [1],
  dayOfMonth: 1,
};

export function cronFormEquals(left: CronForm, right: CronForm): boolean {
  if (left.cadence !== right.cadence) return false;
  if (left.minute !== right.minute || left.hour !== right.hour) return false;
  if (left.cadence === 'hourly') return left.hourStep === right.hourStep;
  if (left.cadence === 'weekly') {
    return left.weekdays.length === right.weekdays.length
      && [...left.weekdays].toSorted((a, b) => a - b).every((day, index) => day === [...right.weekdays].toSorted((a, b) => a - b)[index]);
  }
  if (left.cadence === 'monthly') return left.dayOfMonth === right.dayOfMonth;
  return true;
}

/** Whether an expression is something the engine's own parser would accept. */
export function isValidCron(raw: string): boolean {
  return parseCron(raw).ok;
}
