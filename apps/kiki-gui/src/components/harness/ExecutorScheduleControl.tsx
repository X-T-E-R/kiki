import type { ExecutionOverrides, ExecutorCatalogItem, ExecutorInstanceChoice } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { INPUT } from '../ui';

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
  id, executorId, catalog, value, disabled = false, className = INPUT, onChange,
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
  return (
    <select id={id} data-executor-schedule={family} className={className} value={current} disabled={disabled}
      onChange={(event) => { onChange(scheduleChoiceFromDraft(event.target.value)); }}>
      <option value="">{t('st.engines.schedule.inherit')}</option>
      <option value="main">{t('st.engines.schedule.main')}</option>
      <option value="auto">{t('st.engines.schedule.auto')}</option>
      {instances.map((item) => <option key={item.id} value={item.id}>{item.instance?.label ?? item.label}</option>)}
      {current.startsWith('account:') ? <option value={current}>{t('st.engines.schedule.account', { account: current.slice('account:'.length) })}</option> : null}
      {!known && current !== '' ? <option value={current}>{current}</option> : null}
    </select>
  );
}
