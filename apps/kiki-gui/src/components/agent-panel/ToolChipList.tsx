import { memo } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { CapabilityStateBadge, CAPABILITY_STATE_LABEL_KEYS } from './CapabilityStateBadge';
import type { CapabilityState } from './types';

const TOOL_CATEGORY_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  'os/backends': 'agentPanel.category.osBackends',
  threadCommunication: 'agentPanel.category.threadCommunication',
  agentTask: 'agentPanel.category.agentTask',
  taskBoard: 'agentPanel.category.taskBoard',
  nbSearch: 'agentPanel.category.nbSearch',
  questionTools: 'agentPanel.category.questionTools',
  toolSelect: 'agentPanel.category.toolSelect',
  subagent: 'agentPanel.category.subagent',
  goal: 'agentPanel.category.goal',
  plan: 'agentPanel.category.plan',
  todo: 'agentPanel.category.todo',
  skill: 'agentPanel.category.skill',
  edit: 'agentPanel.category.edit',
  builtin: 'agentPanel.category.builtin',
  other: 'agentPanel.category.other',
};

/**
 * Display label for a tool category. Known server categories map to localized
 * labels (`agentPanel.category.*`), while `mcp:<server>` and unknown values
 * fall back to their raw string.
 */
export function toolCategoryLabel(t: (key: I18nKey) => string, category: string): string {
  const key = TOOL_CATEGORY_LABEL_KEYS[category];
  return key === undefined ? category : t(key);
}

export interface ToolChipItem {
  readonly key: string;
  readonly name: string;
  readonly icon?: string;
  readonly state?: CapabilityState;
  readonly readOnly?: boolean;
  readonly unavailableReason?: string;
  readonly source?: string;
  readonly onOpen?: () => void;
}

export interface ToolChipListProps {
  readonly items: readonly ToolChipItem[];
  readonly variant: 'chips' | 'rows' | 'plain';
}

export const ToolChipList = memo(function ToolChipList({
  items,
  variant,
}: ToolChipListProps) {
  const { t } = useI18n();

  if (variant === 'plain') {
    return (
      <>
        {items.map((item) => (
          <p key={item.key} className="break-words">
            {item.name}
            {item.source !== undefined ? ` · ${item.source}` : ''}
            {item.state !== undefined ? ` · ${t(CAPABILITY_STATE_LABEL_KEYS[item.state])}` : ''}
            {item.unavailableReason !== undefined ? ` · ${item.unavailableReason}` : ''}
          </p>
        ))}
      </>
    );
  }

  if (variant === 'rows') {
    return (
      <div className="divide-y divide-hairline/60 rounded-md border border-hairline bg-panel overflow-hidden">
        {items.map((item) => (
          <div
            key={item.key}
            className="flex items-center justify-between gap-2 p-2 hover:bg-paper/70 transition-colors"
          >
            {item.onOpen ? (
              <button
                type="button"
                onClick={item.onOpen}
                className="font-mono text-[11.5px] font-medium text-ink hover:text-accent truncate text-left cursor-pointer flex-1 min-w-0"
                title={t('agentPanel.viewDetails')}
              >
                {item.icon ? <span className="mr-1">{item.icon}</span> : null}
                {item.name}
              </button>
            ) : (
              <span className="font-mono text-[11.5px] font-medium text-ink truncate flex-1 min-w-0">
                {item.icon ? <span className="mr-1">{item.icon}</span> : null}
                {item.name}
              </span>
            )}
            <div className="flex items-center gap-1 shrink-0">
              {item.readOnly ? (
                <span className="rounded-sm bg-accent-soft px-1 text-[9px] font-mono text-accent">
                  {t('agentPanel.readOnly')}
                </span>
              ) : null}
              {item.state !== undefined ? (
                <CapabilityStateBadge state={item.state} title={item.unavailableReason} />
              ) : null}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // variant === 'chips'
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => {
        const content = (
          <>
            {item.icon ? <span className="mr-1" aria-hidden>{item.icon}</span> : null}
            <span>{item.name}</span>
            {item.state !== undefined ? (
              <CapabilityStateBadge state={item.state} title={item.unavailableReason} className="ml-1" />
            ) : null}
          </>
        );
        const baseClass =
          'rounded bg-paper border border-hairline px-1.5 py-0.2 text-[9.5px] text-ink font-medium inline-flex items-center';

        return item.onOpen ? (
          <button
            key={item.key}
            type="button"
            onClick={item.onOpen}
            title={item.unavailableReason ?? t('agentPanel.viewDetails')}
            className={`${baseClass} hover:border-hairline-strong hover:text-accent cursor-pointer transition-colors`}
          >
            {content}
          </button>
        ) : (
          <span key={item.key} title={item.unavailableReason} className={baseClass}>
            {content}
          </span>
        );
      })}
    </div>
  );
});
