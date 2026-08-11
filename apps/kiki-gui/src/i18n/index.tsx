/**
 * React binding for the i18n layer: `I18nProvider` owns the locale state
 * (persisted to `kiki.locale`, defaulted from `navigator.language`, switched
 * instantly without a reload), sets `<html lang>`, and hands out `t` /
 * `tp` plus locale-bound time formatters.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { formatDuration, formatTokens, relativeTime, timeUntil } from '../lib/time';
import {
  detectLocale,
  LOCALE_STORAGE_KEY,
  translate,
  translatePlural,
  type I18nKey,
  type I18nParams,
  type Locale,
  type PluralBase,
} from './locale';

export type { Locale } from './locale';

export interface TimeFormatters {
  readonly relativeTime: (iso: string) => string;
  readonly timeUntil: (iso: string) => string;
  readonly formatDuration: (ms: number) => string;
  readonly formatTokens: (count: number) => string;
  readonly absoluteTime: (iso: string | undefined) => string | undefined;
}

interface I18nValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: I18nKey, params?: I18nParams) => string;
  /** Count-sensitive copy: picks the `.one` / `.other` variant of `base`. */
  readonly tp: (base: PluralBase, count: number, params?: I18nParams) => string;
  readonly time: TimeFormatters;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the navigator default still applies.
  }
  return detectLocale({
    stored,
    navigatorLanguage: typeof navigator === 'undefined' ? null : navigator.language,
  });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // A session-only switch is still useful when storage is unavailable.
    }
  }, []);

  const t = useCallback(
    (key: I18nKey, params?: I18nParams) => translate(locale, key, params),
    [locale],
  );
  const tp = useCallback(
    (base: PluralBase, count: number, params?: I18nParams) =>
      translatePlural(locale, base, count, params),
    [locale],
  );

  const time = useMemo<TimeFormatters>(
    () => ({
      relativeTime: (iso) => relativeTime(iso, locale),
      timeUntil: (iso) => timeUntil(iso, locale),
      formatDuration: (ms) => formatDuration(ms, locale),
      formatTokens,
      absoluteTime: (iso) => {
        if (iso === undefined) return undefined;
        const date = new Date(iso);
        return Number.isNaN(date.getTime())
          ? undefined
          : date.toLocaleString(locale === 'zh' ? 'zh-CN' : undefined);
      },
    }),
    [locale],
  );

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t, tp, time }),
    [locale, setLocale, t, tp, time],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useI18n outside I18nProvider');
  return value;
}
