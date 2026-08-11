/**
 * Locale machinery — framework-free so lib modules (time, settings,
 * attachments) can localize without React. The React provider lives in
 * `index.tsx`; dictionaries in `en.ts` / `zh.ts`.
 *
 * Missing-key behavior: zh is typed `Record<I18nKey, string>` so gaps are
 * compile errors; at runtime `translate` still falls back to English and then
 * to the raw key, so a stale build degrades instead of crashing.
 */

import { en } from './en';
import { zh } from './zh';

export type Locale = 'en' | 'zh';
export type I18nKey = keyof typeof en;
export type I18nParams = Readonly<Record<string, string | number>>;

export const LOCALE_STORAGE_KEY = 'kiki.locale';

const DICTIONARIES: Record<Locale, Record<I18nKey, string>> = { en, zh };

/**
 * Resolution order: an explicit stored choice wins; otherwise the browser
 * language (`zh*` → Chinese, everything else → English fallback).
 */
export function detectLocale(input: {
  stored?: string | null;
  navigatorLanguage?: string | null;
}): Locale {
  if (input.stored === 'en' || input.stored === 'zh') return input.stored;
  const nav = input.navigatorLanguage?.toLowerCase() ?? '';
  return nav.startsWith('zh') ? 'zh' : 'en';
}

/** `{name}` interpolation; unknown placeholders are left intact. */
export function translate(locale: Locale, key: I18nKey, params?: I18nParams): string {
  const template = DICTIONARIES[locale][key] ?? en[key] ?? key;
  if (params === undefined) return template;
  return template.replaceAll(/\{(\w+)\}/g, (raw, name: string) => {
    const value = params[name];
    return value === undefined ? raw : String(value);
  });
}

/** Keys that come in `.one` / `.other` pairs, for count-sensitive copy. */
export type PluralBase = {
  [K in I18nKey]: K extends `${infer Base}.one` ? Base : never;
}[I18nKey];

export function translatePlural(
  locale: Locale,
  base: PluralBase,
  count: number,
  params?: I18nParams,
): string {
  const key = `${base}.${count === 1 ? 'one' : 'other'}` as I18nKey;
  return translate(locale, key, { ...params, count });
}

/** A validation failure that carries its dictionary key plus an English message. */
export interface ValidationIssue {
  readonly key: I18nKey;
  readonly params?: I18nParams;
}

/** Render an issue in the active locale (components) or English (throwers/tests). */
export function issueText(locale: Locale, issue: ValidationIssue): string {
  return translate(locale, issue.key, issue.params);
}

/**
 * Error whose message is English (existing tests and logs stay stable) while
 * `issue` lets UI catch-sites render the active locale.
 */
export class LocalizedError extends Error {
  readonly issue: ValidationIssue;
  constructor(issue: ValidationIssue) {
    super(issueText('en', issue));
    this.name = 'LocalizedError';
    this.issue = issue;
  }
}

/** Localize a caught error when it carries an issue; otherwise pass through. */
export function errorText(locale: Locale, error: unknown): string {
  if (error instanceof LocalizedError) return issueText(locale, error.issue);
  return error instanceof Error ? error.message : String(error);
}
