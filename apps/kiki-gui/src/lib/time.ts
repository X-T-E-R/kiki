/** Relative/duration time formatting for the UI, localized via the i18n layer. */

import { translate, type Locale } from '../i18n/locale';

export function relativeTime(iso: string, locale: Locale = 'en'): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 10) return translate(locale, 'time.justNow');
  if (seconds < 60) return translate(locale, 'time.secondsAgo', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return translate(locale, 'time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate(locale, 'time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return translate(locale, 'time.daysAgo', { n: days });
  const date = new Date(then);
  return date.toLocaleDateString(locale === 'zh' ? 'zh-CN' : undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatDuration(ms: number, locale: Locale = 'en'): string {
  if (ms < 1000) return translate(locale, 'time.durationMs', { n: Math.round(ms) });
  const seconds = ms / 1000;
  if (seconds < 60) return translate(locale, 'time.durationSeconds', { n: seconds.toFixed(1) });
  const minutes = Math.floor(seconds / 60);
  return translate(locale, 'time.durationMinutes', { m: minutes, s: Math.round(seconds % 60) });
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** "in 5m" style for future instants; 'expired' once past. */
export function timeUntil(iso: string, locale: Locale = 'en'): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.floor((then - Date.now()) / 1000);
  if (seconds <= 0) return translate(locale, 'time.expired');
  if (seconds < 60) return translate(locale, 'time.secondsLeft', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return translate(locale, 'time.minutesLeft', { n: minutes });
  const hours = Math.floor(minutes / 60);
  return translate(locale, 'time.hoursLeft', { n: hours });
}
