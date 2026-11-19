import type { I18nKey } from '@kiki/session-core/i18n';

export type EffortTranslate = (key: I18nKey, params?: Readonly<Record<string, string | number>>) => string;

export function formatThinkingEffort(effort: string, t: EffortTranslate): string {
  const level = effort.trim();
  if (level === '') return '';
  const key = `composer.effort.${level}` as I18nKey;
  const translated = t(key);
  return t('subagent.effort', { effort: translated === key ? level : translated });
}
