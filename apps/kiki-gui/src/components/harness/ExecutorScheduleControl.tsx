import type { ExecutionOverrides, ExecutorCatalogItem, ExecutorInstanceChoice } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { FORM_SELECT_TRIGGER } from '../settings/SettingsPrimitives';

type ScheduleCatalogItem = Pick<ExecutorCatalogItem, 'id' | 'label' | 'instance'>;

export function familyExecutorId(executorId: string, catalog: readonly ScheduleCatalogItem[]): string {
  return catalog.find((item) => item.id === executorId)?.instance?.source_executor ?? executorId;
}

export function scheduleChoiceValue(choice: ExecutorInstanceChoice | null | undefined): string {
  if (choice === undefined || choice === null) return '';
  return typeof choice === 'string' ? choice : `account:${choice.account_id}`;
}

export function scheduleChoiceFromDraft(value: string): '' | ExecutorInstanceChoice {
  if (value === '' || value === 'main' || value === 'auto') return value;
  if (/^instance-[a-z0-9][a-z0-9-]{0,79}$/.test(value)) return value;
  if (value.startsWith('account:') && value.length > 'account:'.length) return { account_id: value.slice('account:'.length) };
  return '';
}

/** Keep a session instance choice when the clicked engine can still use it. */
export function passthroughScheduleOverrides(
  overrides: ExecutionOverrides | undefined,
  executorId: string,
  catalog: readonly ScheduleCatalogItem[],
): ExecutionOverrides | undefined {
  const choice = overrides?.executor_instance;
  if (choice === undefined || choice === null) return undefined;
  if (choice === 'main' || choice === 'auto' || typeof choice !== 'string') return { executor_instance: choice };
  const owner = catalog.find((item) => item.id === choice)?.instance?.source_executor;
  return owner === undefined || owner === familyExecutorId(executorId, catalog) ? { executor_instance: choice } : undefined;
}

export function ExecutorScheduleControl({
  id, executorId, catalog, value, disabled = false, className, onChange,
}: {
  id?: string;
  executorId: string;
  catalog: readonly ScheduleCatalogItem[];
  value: ExecutorInstanceChoice | null | undefined;
  disabled?: boolean;
  className?: string;
  onChange: (next: '' | ExecutorInstanceChoice) => void;
}) {
  const { t } = useI18n();
  const family = familyExecutorId(executorId, catalog);
  const instances = catalog.filter((item) => item.instance?.source_executor === family);
  const current = scheduleChoiceValue(value);
  const known = current === '' || current === 'main' || current === 'auto'
    || instances.some((item) => item.id === current) || current.startsWith('account:');
  const options: SearchableSelectOption[] = [
    { value: '', label: t('st.engines.schedule.inherit') },
    { value: 'main', label: t('st.engines.schedule.main') },
    { value: 'auto', label: t('st.engines.schedule.auto') },
    ...instances.map((item) => ({ value: item.id, label: item.instance?.label ?? item.label })),
    ...(current.startsWith('account:') ? [{ value: current, label: t('st.engines.schedule.account', { account: current.slice('account:'.length) }) }] : []),
    ...(!known && current !== '' ? [{ value: current, label: current }] : []),
  ];
  return (
    <SearchableSelect
      id={id}
      options={options}
      value={current}
      disabled={disabled}
      ariaLabel={t('st.engines.schedule.label')}
      triggerData={{ 'data-executor-schedule': family }}
      buttonClassName={className !== undefined ? `${FORM_SELECT_TRIGGER} ${className}` : FORM_SELECT_TRIGGER}
      onChange={(next) => { onChange(scheduleChoiceFromDraft(next)); }}
    />
  );
}
