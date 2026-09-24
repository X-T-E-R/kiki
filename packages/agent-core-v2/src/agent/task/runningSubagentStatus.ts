import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentTaskService } from '#/agent/task/task';
import { escapeXmlTags } from '#/_base/utils/xml-escape';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

type Locale = 'en' | 'zh';

const MAX_VISIBLE_NAMES = 5;
const MESSAGES = {
  en: {
    one: '1 subagent still running: {names}',
    other: '{count} subagents still running: {names}',
    more: ', and {count} more',
    separator: ', ',
  },
  zh: {
    one: '还有 1 个 subagent 正在运行：{names}',
    other: '还有 {count} 个 subagent 正在运行：{names}',
    more: ' 等 {count} 个',
    separator: '、',
  },
} satisfies Record<Locale, Record<'one' | 'other' | 'more' | 'separator', string>>;

export function runningSubagentStatus(
  tasks: Pick<IAgentTaskService, 'list'>,
  lifecycle: Pick<IAgentLifecycleService, 'list'>,
  parentAgentId: string,
  excludedAgentId?: string,
  locale: Locale = environmentLocale(),
): string | undefined {
  const running = new Map<string, string>();
  for (const task of tasks.list(true)) {
    if (task.kind === 'agent' && task.agentId !== undefined && task.agentId !== excludedAgentId) {
      running.set(task.agentId, task.collaborationTaskName ?? task.agentId);
    }
  }
  for (const handle of lifecycle.list()) {
    if (handle.id === excludedAgentId) continue;
    if (handle.accessor.get(IAgentScopeContext).parentAgentId !== parentAgentId) continue;
    const state = handle.accessor.get(IAgentExecutionService).status().state;
    if (state === 'broken') running.delete(handle.id);
    else if (state !== 'idle') running.set(handle.id, running.get(handle.id) ?? handle.id);
  }
  if (running.size === 0) return undefined;

  const names = [...running.values()].toSorted((left, right) => left.localeCompare(right));
  const copy = MESSAGES[locale];
  const shown = names.slice(0, MAX_VISIBLE_NAMES).map(escapeXmlTags).join(copy.separator);
  const remaining = names.length - MAX_VISIBLE_NAMES;
  const list = remaining > 0
    ? `${shown}${copy.more.replace('{count}', String(remaining))}`
    : shown;
  return (names.length === 1 ? copy.one : copy.other)
    .replace('{count}', String(names.length))
    .replace('{names}', list);
}

function environmentLocale(): Locale {
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
