/**
 * Field-level validators shared by the service cards. Each returns a localized
 * issue or null; empty means "inherit", which is always valid.
 */

import type { useI18n } from '../../../i18n';

export const BALANCE_TTL_MIN = 60_000;
export const BALANCE_TTL_MAX = 86_400_000;

export function balanceTtlIssue(t: ReturnType<typeof useI18n>['t'], raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < BALANCE_TTL_MIN || value > BALANCE_TTL_MAX) {
    return t('st.nbSearch.service.balanceTtlInvalid');
  }
  return null;
}

export function baseUrlIssue(t: ReturnType<typeof useI18n>['t'], raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  return /^https?:\/\//i.test(text) ? null : t('st.nbSearch.providers.baseUrlInvalid');
}

export function optionsIssue(t: ReturnType<typeof useI18n>['t'], raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? null
      : t('st.nbSearch.providers.optionsInvalid');
  } catch {
    return t('st.nbSearch.providers.optionsInvalid');
  }
}
