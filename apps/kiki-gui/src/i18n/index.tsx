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

import {
  detectLocale,
  hasLocaleDictionary,
  LOCALE_STORAGE_KEY,
  registerLocaleDictionary,
  translate,
  translatePlural,
  type I18nKey,
  type I18nParams,
  type Locale,
  type PluralBase,
} from '@kiki/session-core/i18n';
import { formatDuration, formatTokens, relativeTime, timeUntil } from '@kiki/session-core/util';

export type { Locale } from '@kiki/session-core/i18n';

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

const LOCALE_LOADERS: Record<Locale, () => Promise<Partial<Record<I18nKey, string>>>> = {
  en: async () => (await import('@kiki/session-core/i18n/en')).en,
  zh: async () => (await import('@kiki/session-core/i18n/zh')).zh,
};

const inFlightLocaleLoads = new Map<Locale, Promise<void>>();

export async function ensureLocaleLoaded(locale: Locale): Promise<void> {
  if (hasLocaleDictionary(locale)) return;
  let pending = inFlightLocaleLoads.get(locale);
  if (pending === undefined) {
    pending = LOCALE_LOADERS[locale]()
      .then((dict) => {
        registerLocaleDictionary(locale, dict);
      })
      .finally(() => {
        inFlightLocaleLoads.delete(locale);
      });
    inFlightLocaleLoads.set(locale, pending);
  }
  await pending;
}

export async function ensureInitialLocaleLoaded(): Promise<void> {
  await ensureLocaleLoaded(initialLocale());
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [, setDictionaryRevision] = useState(0);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  useEffect(() => {
    if (hasLocaleDictionary(locale)) return;
    let active = true;
    void ensureLocaleLoaded(locale).then(() => {
      if (active) setDictionaryRevision((n) => n + 1);
    });
    return () => {
      active = false;
    };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // A session-only switch is still useful when storage is unavailable.
    }
    if (hasLocaleDictionary(next)) {
      setLocaleState(next);
      return;
    }
    void ensureLocaleLoaded(next).then(() => {
      setLocaleState(next);
    });
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

  const time = useMemo<TimeFormatters>(() => {
    const absoluteLocale = locale === 'zh' ? 'zh-CN' : undefined;
    const absoluteFormatter = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
      ? new Intl.DateTimeFormat(absoluteLocale, {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
        })
      : null;
    const absoluteCache = new Map<string, string>();
    return {
      relativeTime: (iso) => relativeTime(iso, locale),
      timeUntil: (iso) => timeUntil(iso, locale),
      formatDuration: (ms) => formatDuration(ms, locale),
      formatTokens,
      absoluteTime: (iso) => {
        if (iso === undefined) return undefined;
        const cached = absoluteCache.get(iso);
        if (cached !== undefined) return cached;
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return undefined;
        const formatted = absoluteFormatter !== null
          ? absoluteFormatter.format(date)
          : date.toLocaleString(absoluteLocale);
        if (absoluteCache.size >= 512) absoluteCache.clear();
        absoluteCache.set(iso, formatted);
        return formatted;
      },
    };
  }, [locale]);

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
