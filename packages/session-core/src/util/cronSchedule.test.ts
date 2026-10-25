import { describe, expect, it } from 'vitest';

import { translate } from '../i18n/locale';
import {
  DEFAULT_CRON_FORM,
  cronFormEquals,
  isValidCron,
  localizedCronSchedule,
  parseCron,
  readCronForm,
  writeCronForm,
} from './cronSchedule';

const zh = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('zh', key, params);
const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params);

function parsedValues(raw: string) {
  const result = parseCron(raw);
  expect(result.ok, `${raw} should parse`).toBe(true);
  if (!result.ok) throw new Error(`Invalid cron: ${raw}`);
  const parsed = result.parsed;
  return {
    minutes: [...parsed.minutes.values].toSorted((a, b) => a - b),
    hours: [...parsed.hours.values].toSorted((a, b) => a - b),
    daysOfMonth: [...parsed.daysOfMonth.values].toSorted((a, b) => a - b),
    months: [...parsed.months.values].toSorted((a, b) => a - b),
    daysOfWeek: [...parsed.daysOfWeek.values].toSorted((a, b) => a - b),
    daysOfMonthWildcard: parsed.daysOfMonth.wildcard,
    daysOfWeekWildcard: parsed.daysOfWeek.wildcard,
  };
}

describe('parseCron', () => {
  it.each([
    ['5', [5]],
    ['5/15', [5, 20, 35, 50]],
    ['*/15', [0, 15, 30, 45]],
    ['0/15', [0, 15, 30, 45]],
    ['5-10', [5, 6, 7, 8, 9, 10]],
    ['5-10/3', [5, 8]],
    ['0-59/17', [0, 17, 34, 51]],
    ['5/15,7-10/2,50', [5, 7, 9, 20, 35, 50]],
    ['0,15', [0, 15]],
    ['*/60', [0]],
    ['58/3', [58]],
  ])('expands minute term %s using the engine grammar', (field, expected) => {
    expect(parsedValues(`${field} * * * *`).minutes).toEqual(expected);
  });

  it('expands steps using each field boundary and normalizes Sunday', () => {
    const parsed = parsedValues('5/15 5/6 5/10 3/4 5/2');
    expect(parsed.hours).toEqual([5, 11, 17, 23]);
    expect(parsed.daysOfMonth).toEqual([5, 15, 25]);
    expect(parsed.months).toEqual([3, 7, 11]);
    expect(parsed.daysOfWeek).toEqual([0, 5]);
    expect(parsedValues('0 9 * * 0,7').daysOfWeek).toEqual([0]);
    expect(parsedValues('0 9 * * 1-7/2').daysOfWeek).toEqual([0, 1, 3, 5]);
  });

  it.each([
    '/15', '*/', '5/', '*/0', '*/-1', '*/+1', '*/1.5', '*/2/3',
    '+5', '-5', '1.5', '5-', '-10', '10-5', '0-60', '60', '0,,15', '0,', '*,',
  ])('rejects invalid minute term %s rather than treating it as advanced', (field) => {
    const raw = `${field} * * * *`;
    expect(parseCron(raw).ok).toBe(false);
    expect(readCronForm(raw)).toEqual({ kind: 'invalid', raw });
  });

  it.each(['0 24 * * *', '0 9 0 * *', '0 9 * 0 *', '0 9 * * 8'])('rejects out-of-bounds fields in %s', (raw) => {
    expect(isValidCron(raw)).toBe(false);
  });
});

describe('localizedCronSchedule', () => {
  it('names the hourly shapes in the active locale instead of the engine English', () => {
    expect(localizedCronSchedule('zh', '0 * * * *', zh)).toBe('每小时整点');
    expect(localizedCronSchedule('zh', '*/30 * * * *', zh)).toBe('每 30 分钟');
    expect(localizedCronSchedule('zh', '30 * * * *', zh)).toBe('每小时第 30 分钟');
    expect(localizedCronSchedule('zh', '0 */4 * * *', zh)).toBe('每 4 小时整点');
    expect(localizedCronSchedule('zh', '10 */6 * * *', zh)).toBe('每 6 小时的第 10 分钟');
    expect(localizedCronSchedule('zh', '*/4 * * * *', zh)).toBe('每 4 分钟');
    expect(localizedCronSchedule('zh', '* * * * *', zh)).toBe('每分钟');
  });

  it('does not name partial arithmetic sets as whole-field steps', () => {
    expect(localizedCronSchedule('en', '0,15 * * * *', en)).toBeUndefined();
    expect(localizedCronSchedule('en', '0 0,5 * * *', en)).toBe('Every day at 00:00, 05:00');
    expect(localizedCronSchedule('en', '0 0,15 * * *', en)).toBe('Every 15 hours on the hour');
    expect(localizedCronSchedule('en', '0,15,30,45 * * * *', en)).toBe('Every 15 minutes');
    expect(localizedCronSchedule('en', '0-59/17 * * * *', en)).toBe('Every 17 minutes');
    expect(localizedCronSchedule('en', '0 0,7,14,21 * * *', en)).toBe('Every 7 hours on the hour');
    expect(localizedCronSchedule('en', '5/15 * * * *', en)).toBeUndefined();
  });

  it('keeps minute labels honest about restricted hours', () => {
    expect(localizedCronSchedule('en', '*/15 9 * * *', en)).toBe('Every day at 09:00, 09:15, 09:30, 09:45');
    expect(localizedCronSchedule('en', '* 9 * * *', en)).toBeUndefined();
    expect(localizedCronSchedule('en', '*/15 */2 * * *', en)).toBeUndefined();
    expect(localizedCronSchedule('en', '* */2 * * *', en)).toBeUndefined();
    expect(localizedCronSchedule('en', '*/15 0-23 * * *', en)).toBe('Every 15 minutes');
    expect(localizedCronSchedule('en', '5/15 9 * * *', en)).toBe('Every day at 09:05, 09:20, 09:35, 09:50');
  });

  it('names the daily and weekly shapes', () => {
    expect(localizedCronSchedule('zh', '0 9 * * *', zh)).toBe('每天 09:00');
    expect(localizedCronSchedule('zh', '0 18 * * 1-5', zh)).toBe('工作日 18:00');
    expect(localizedCronSchedule('zh', '0 10 * * 0,6', zh)).toBe('周末 10:00');
    expect(localizedCronSchedule('zh', '30 8 * * 1', zh)).toBe('每周一 08:30');
    expect(localizedCronSchedule('zh', '0 10 * * 1,3', zh)).toBe('每周一、三 10:00');
  });

  it('names the monthly and yearly shapes', () => {
    expect(localizedCronSchedule('zh', '15 7 1 * *', zh)).toBe('每月 1 日 07:15');
    expect(localizedCronSchedule('zh', '0 6 25 12 *', zh)).toBe('每年 12 月 25 日 06:00');
    expect(localizedCronSchedule('en', '0 6 25 12 *', en)).toBe('Every December 25 at 06:00');
  });

  it('speaks English when the locale is English', () => {
    expect(localizedCronSchedule('en', '0 * * * *', en)).toBe('Every hour on the hour');
    expect(localizedCronSchedule('en', '0 9 * * *', en)).toBe('Every day at 09:00');
    expect(localizedCronSchedule('en', '30 8 * * 1', en)).toBe('Every Monday at 08:30');
  });

  it('reads Sunday written as 7 the same as 0', () => {
    expect(localizedCronSchedule('zh', '0 9 * * 7', zh)).toBe('每周日 09:00');
  });

  it('names several times in one day as a list', () => {
    expect(localizedCronSchedule('zh', '5,25,45 9 * * *', zh)).toBe('每天 09:05、09:25、09:45');
    expect(localizedCronSchedule('zh', '0 9,17 * * *', zh)).toBe('每天 09:00、17:00');
  });

  it('leaves a rule with no readable name to the caller', () => {
    expect(localizedCronSchedule('zh', '5,25 9,17 * * *', zh)).toBeUndefined();
    expect(localizedCronSchedule('zh', 'not a cron', zh)).toBeUndefined();
    expect(localizedCronSchedule('zh', '', zh)).toBeUndefined();
  });
});

describe('readCronForm', () => {
  it('turns the common expressions into the readable controls', () => {
    const hourly = readCronForm('0 * * * *');
    expect(hourly.kind).toBe('friendly');
    expect(hourly.kind === 'friendly' && hourly.form).toEqual({
      cadence: 'hourly', minute: 0, hour: 0, hourStep: 1, weekdays: [], dayOfMonth: 1,
    });

    const daily = readCronForm('0 9 * * *');
    expect(daily.kind === 'friendly' && daily.form.cadence).toBe('daily');
    expect(daily.kind === 'friendly' && daily.form.hour).toBe(9);

    const weekly = readCronForm('30 8 * * 1');
    expect(weekly.kind === 'friendly' && weekly.form).toEqual({
      cadence: 'weekly', minute: 30, hour: 8, hourStep: 1, weekdays: [1], dayOfMonth: 1,
    });

    const monthly = readCronForm('15 7 1 * *');
    expect(monthly.kind === 'friendly' && monthly.form).toEqual({
      cadence: 'monthly', minute: 15, hour: 7, hourStep: 1, weekdays: [], dayOfMonth: 1,
    });
  });

  it.each([
    '0 9 15 * 1',
    '5,25 9 * * *',
    '*/30 * * * *',
    '* * * * *',
    '5/15 * * * *',
    '0,15 * * * *',
    '0 0,5 * * *',
    '0 5/6 * * *',
    '0 0-15/5 * * *',
    '0 0,15 * * *',
    '0 0,7,14,21 * * *',
    '0 0-23/5 * * *',
    '0 9 */2 * *',
    '0 9 * 3/4 *',
    '  */30   * * * *  ',
    '\t0 9 15 * 1\n',
  ])('reports unsupported rule %s as advanced and keeps its text verbatim', (raw) => {
    expect(readCronForm(raw)).toEqual({ kind: 'advanced', raw });
  });

  it.each([
    '0 * * * *',
    '30 */3 * * *',
    '0 0,4,8,12,16,20 * * *',
    '0 0-23/6 * * *',
    '0 0/4 * * *',
    '0 */25 * * *',
    '58/3 9 * * *',
    '*/60 9 * * *',
    '0 9 * 1/1 *',
    '  05 09 * 1-12 *  ',
    '30 8 * * 1',
    '0 9 * * 1-5',
    '0 9 * * 0,7',
    '0 9 * * 5/2',
    '0 9 * * 1-7/2',
    '0 9 * * */1',
    '15 7 1 * *',
    '45 6 28 1-12 *',
  ])('recognizes %s reversibly without changing its parsed firing set', (raw) => {
    const read = readCronForm(raw);
    expect(read.kind).toBe('friendly');
    if (read.kind !== 'friendly') throw new Error(`Expected friendly cron: ${raw}`);
    const written = writeCronForm(read.form);
    expect(read.cron).toBe(written);
    expect(parsedValues(written)).toEqual(parsedValues(raw));
  });

  it('reports unparseable text as invalid rather than advanced', () => {
    expect(readCronForm('nonsense').kind).toBe('invalid');
    expect(readCronForm('0 9 * *').kind).toBe('invalid');
    expect(readCronForm('99 9 * * *').kind).toBe('invalid');
  });
});

describe('writeCronForm', () => {
  it('round-trips every cadence the controls offer', () => {
    const cases = [
      { cadence: 'hourly' as const, minute: 0, hour: 0, hourStep: 1, weekdays: [], dayOfMonth: 1 },
      { cadence: 'hourly' as const, minute: 30, hour: 0, hourStep: 3, weekdays: [], dayOfMonth: 1 },
      { cadence: 'daily' as const, minute: 5, hour: 23, hourStep: 1, weekdays: [], dayOfMonth: 1 },
      { cadence: 'weekly' as const, minute: 0, hour: 9, hourStep: 1, weekdays: [1, 3], dayOfMonth: 1 },
      { cadence: 'weekly' as const, minute: 0, hour: 9, hourStep: 1, weekdays: [0], dayOfMonth: 1 },
      { cadence: 'monthly' as const, minute: 45, hour: 6, hourStep: 1, weekdays: [], dayOfMonth: 28 },
    ];
    for (const form of cases) {
      const cron = writeCronForm(form);
      const back = readCronForm(cron);
      expect(back.kind, `${cron} should read back as friendly`).toBe('friendly');
      expect(back.kind === 'friendly' && back.form).toEqual(form);
    }
  });

  it('produces a fresh task schedule the engine would accept', () => {
    expect(isValidCron(writeCronForm(DEFAULT_CRON_FORM))).toBe(true);
    expect(writeCronForm(DEFAULT_CRON_FORM)).toBe('0 9 * * *');
  });

  it('collapses a weekday run back into a range', () => {
    expect(writeCronForm({ ...DEFAULT_CRON_FORM, cadence: 'weekly', weekdays: [1, 2, 3, 4, 5] }))
      .toBe('0 9 * * 1-5');
  });
});

describe('cronFormEquals', () => {
  it('ignores weekday order but not weekday membership', () => {
    const base = { ...DEFAULT_CRON_FORM, cadence: 'weekly' as const };
    expect(cronFormEquals({ ...base, weekdays: [3, 1] }, { ...base, weekdays: [1, 3] })).toBe(true);
    expect(cronFormEquals({ ...base, weekdays: [1, 3] }, { ...base, weekdays: [1] })).toBe(false);
  });
});
