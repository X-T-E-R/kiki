import { Cron, CronPattern } from 'croner';

import { Error2, ErrorCodes } from '#/errors';

export interface ParsedCronExpression {
  readonly raw: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly daysOfMonthWildcard: boolean;
  readonly daysOfWeekWildcard: boolean;
}

const FIELD_SPECS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;

const MS_PER_MINUTE = 60_000;
const DIGIT_ONLY = /^\d+$/;
const CRON_CACHE = new WeakMap<ParsedCronExpression, Cron>();

export function parseCronExpression(expr: string): ParsedCronExpression {
  if (typeof expr !== 'string') {
    throw new Error2(ErrorCodes.CRON_EXPRESSION_INVALID, 'cron expression must be a string', {
      details: { received: typeof expr },
    });
  }
  const trimmed = expr.trim();
  if (trimmed === '') {
    throw new Error2(ErrorCodes.CRON_EXPRESSION_INVALID, 'cron expression is empty');
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error2(
      ErrorCodes.CRON_EXPRESSION_INVALID,
      `cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}`,
      { details: { fieldCount: fields.length } },
    );
  }

  const normalized = fields.map((field, index) => {
    const spec = FIELD_SPECS[index]!;
    return normalizeFieldForCroner(field, spec.min, spec.max, spec.name);
  }).join(' ');

  let pattern: CronPattern;
  let cron: Cron;
  try {
    pattern = new CronPattern(normalized, undefined, { mode: '5-part' });
    cron = new Cron(normalized, { mode: '5-part', paused: true, domAndDow: false });
  } catch (error) {
    throw new Error2(
      ErrorCodes.CRON_EXPRESSION_INVALID,
      error instanceof Error ? error.message : String(error),
      { details: { raw: trimmed } },
    );
  }

  const parsed: ParsedCronExpression = {
    raw: trimmed,
    minutes: collectMask(pattern.minute, 0),
    hours: collectMask(pattern.hour, 0),
    daysOfMonth: collectMask(pattern.day, 1),
    months: collectMask(pattern.month, 1),
    daysOfWeek: collectMask(pattern.dayOfWeek, 0),
    daysOfMonthWildcard: fields[2] === '*',
    daysOfWeekWildcard: fields[4] === '*',
  };
  CRON_CACHE.set(parsed, cron);
  return parsed;
}

function collectMask(mask: readonly number[], offset: number): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) out.add(i + offset);
  }
  return out;
}

function parseCronInt(raw: string, name: string, role: string): number {
  if (!DIGIT_ONLY.test(raw)) {
    throw new Error2(
      ErrorCodes.CRON_EXPRESSION_INVALID,
      `cron ${name} ${role} must be a non-negative integer with digits only (got ${JSON.stringify(raw)})`,
      { details: { field: name, role, value: raw } },
    );
  }
  return Number.parseInt(raw, 10);
}

function normalizeFieldForCroner(field: string, min: number, max: number, name: string): string {
  if (field === '') {
    throw new Error2(ErrorCodes.CRON_EXPRESSION_INVALID, `cron ${name} field is empty`, {
      details: { field: name },
    });
  }
  const normalizedTerms: string[] = [];
  for (const term of field.split(',')) {
    if (term === '') {
      throw new Error2(
        ErrorCodes.CRON_EXPRESSION_INVALID,
        `cron ${name} field has empty term in list`,
        { details: { field: name } },
      );
    }
    normalizedTerms.push(normalizeTermForCroner(term, min, max, name));
  }
  return normalizedTerms.join(',');
}

function normalizeTermForCroner(term: string, min: number, max: number, name: string): string {
  let rangePart = term;
  let step: number | undefined;
  const slash = term.indexOf('/');
  if (slash !== -1) {
    rangePart = term.slice(0, slash);
    const stepStr = term.slice(slash + 1);
    if (stepStr === '') {
      throw new Error2(ErrorCodes.CRON_EXPRESSION_INVALID, `cron ${name} step is empty in "${term}"`, {
        details: { field: name, term },
      });
    }
    const parsedStep = parseCronInt(stepStr, name, 'step');
    if (parsedStep <= 0) {
      throw new Error2(
        ErrorCodes.CRON_EXPRESSION_INVALID,
        `cron ${name} step must be a positive integer (got "${stepStr}")`,
        { details: { field: name, term, step: stepStr } },
      );
    }
    if (rangePart === '') {
      throw new Error2(
        ErrorCodes.CRON_EXPRESSION_INVALID,
        `cron ${name} step needs a range or "*" before "/" in "${term}"`,
        { details: { field: name, term } },
      );
    }
    step = parsedStep;
  }

  let lo: number;
  let hi: number;
  if (rangePart === '*') {
    if (step === undefined) return '*';
    lo = min;
    hi = max;
  } else {
    const dash = rangePart.indexOf('-');
    if (dash === -1) {
      const single = parseCronInt(rangePart, name, 'value');
      if (single < min || single > max) {
        throw new Error2(
          ErrorCodes.CRON_EXPRESSION_INVALID,
          `cron ${name} value ${single} out of range ${min}..${max}`,
          { details: { field: name, value: single, min, max } },
        );
      }
      if (step === undefined) return String(single);
      lo = single;
      hi = max;
    } else {
      lo = parseCronInt(rangePart.slice(0, dash), name, 'range lower bound');
      hi = parseCronInt(rangePart.slice(dash + 1), name, 'range upper bound');
      if (lo < min || hi > max || lo > hi) {
        throw new Error2(
          ErrorCodes.CRON_EXPRESSION_INVALID,
          `cron ${name} range ${lo}-${hi} out of bounds (must be ${min}..${max}, ascending)`,
          { details: { field: name, lo, hi, min, max } },
        );
      }
      if (step === undefined) return `${lo}-${hi}`;
    }
  }

  if (lo + step > hi) return String(lo);
  return rangePart === '*' && hi === max && name !== 'day-of-week'
    ? `*/${step}`
    : `${lo}-${hi}/${step}`;
}

function getCronInstance(expr: ParsedCronExpression): Cron {
  const cached = CRON_CACHE.get(expr);
  if (cached !== undefined) return cached;
  const reparsed = parseCronExpression(expr.raw);
  const cron = CRON_CACHE.get(reparsed)!;
  CRON_CACHE.set(expr, cron);
  return cron;
}

export function computeNextCronRun(expr: ParsedCronExpression, fromMs: number): number | null {
  return nextRunWithinMinutes(expr, fromMs, 5 * 366 * 24 * 60);
}

export function hasFireWithinYears(
  expr: ParsedCronExpression,
  years: number,
  fromMs: number,
): boolean {
  const cap = Math.max(1, Math.floor(years * 366 * 24 * 60));
  return nextRunWithinMinutes(expr, fromMs, cap) !== null;
}

function nextRunWithinMinutes(
  expr: ParsedCronExpression,
  fromMs: number,
  capMinutes: number,
): number | null {
  const cron = getCronInstance(expr);
  const next = cron.nextRun(new Date(fromMs));
  if (next === null) return null;
  const nextMs = next.getTime();
  const deadlineMs = fromMs + capMinutes * MS_PER_MINUTE;
  return nextMs <= deadlineMs ? nextMs : null;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function cronToHuman(expr: ParsedCronExpression): string {
  const allMin = isFullRange(expr.minutes, 0, 59);
  const allHour = isFullRange(expr.hours, 0, 23);
  const allDom = expr.daysOfMonthWildcard;
  const allMonth = isFullRange(expr.months, 1, 12);
  const allDow = expr.daysOfWeekWildcard;

  if (allHour && allDom && allMonth && allDow) {
    const step = detectStep(expr.minutes, 0, 59);
    if (step !== null && step > 1) return `every ${step} minutes`;
    if (allMin) return 'every minute';
    if (expr.minutes.size === 1) {
      const m = [...expr.minutes][0]!;
      return `at minute ${m} of every hour`;
    }
  }

  if (expr.minutes.size === 1 && allDom && allMonth && allDow) {
    const m = [...expr.minutes][0]!;
    const step = detectStep(expr.hours, 0, 23);
    if (step !== null && step > 1) {
      return `every ${step} hours at minute ${pad(m)}`;
    }
  }

  if (
    expr.minutes.size === 1 &&
    expr.hours.size === 1 &&
    allDom &&
    allMonth
  ) {
    const h = [...expr.hours][0]!;
    const m = [...expr.minutes][0]!;
    if (allDow) return `at ${pad(h)}:${pad(m)} every day`;
    const dowStr = formatDows(expr.daysOfWeek);
    if (dowStr !== null) return `at ${pad(h)}:${pad(m)} on ${dowStr}`;
  }

  if (
    expr.minutes.size === 1 &&
    expr.hours.size === 1 &&
    expr.daysOfMonth.size === 1 &&
    !expr.daysOfMonthWildcard &&
    expr.months.size === 1 &&
    allDow
  ) {
    const h = [...expr.hours][0]!;
    const m = [...expr.minutes][0]!;
    const d = [...expr.daysOfMonth][0]!;
    const mo = [...expr.months][0]!;
    return `at ${pad(h)}:${pad(m)} on day ${d} of ${MONTH_NAMES[mo - 1]}`;
  }

  return expr.raw;
}

function isFullRange(set: ReadonlySet<number>, min: number, max: number): boolean {
  if (set.size !== max - min + 1) return false;
  for (let v = min; v <= max; v++) if (!set.has(v)) return false;
  return true;
}

function detectStep(set: ReadonlySet<number>, min: number, max: number): number | null {
  const values = [...set].toSorted((a, b) => a - b);
  if (values.length < 2) return null;
  if (values[0] !== min) return null;
  const step = values[1]! - values[0]!;
  if (step <= 0) return null;
  let expected = min;
  for (const v of values) {
    if (v !== expected) return null;
    expected += step;
  }
  if (expected <= max) return null;
  return step;
}

function formatDows(set: ReadonlySet<number>): string | null {
  const values = [...set].toSorted((a, b) => a - b);
  if (values.length === 0) return null;
  if (values.length === 5 && values.every((v, i) => v === i + 1)) {
    return 'weekdays';
  }
  if (values.length === 2 && values[0] === 0 && values[1] === 6) {
    return 'weekends';
  }
  return values.map((v) => DAY_NAMES[v]!).join(', ');
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
