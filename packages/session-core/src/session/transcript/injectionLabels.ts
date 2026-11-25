import type { I18nKey } from '../../i18n/locale';
import type { ReminderCategory, ReminderCategoryKind } from './types';

const CONTINUITY_CATEGORY_KEYS: Readonly<Record<ReminderCategoryKind, I18nKey>> = {
  directive: 'transcript.reminder.directive',
  renew: 'transcript.reminder.renew',
  rebuild: 'transcript.reminder.rebuild',
  history: 'transcript.reminder.history',
  progress: 'transcript.reminder.progress',
};

const EXACT_VARIANT_KEYS: Readonly<Record<string, I18nKey>> = {
  model_steering: 'transcript.injection.modelSteering',
  subagent_parent_steering: 'transcript.injection.subagentParentSteering',
  runtime_snapshot: 'transcript.injection.runtimeSnapshot',
  agents_md: 'transcript.injection.agentsMd',
  memory_authority: 'transcript.injection.memoryAuthority',
  capability_delta: 'transcript.injection.capabilityUpdate',
  capabilities_rebuilt: 'transcript.injection.capabilityUpdate',
  profile_capabilities_changed: 'transcript.injection.capabilityUpdate',
  agent_profile_changes: 'transcript.injection.agentProfileChanges',
  'loadable-tools': 'transcript.injection.loadableTools',
  dynamic_tool_schema: 'transcript.injection.dynamicToolSchema',
  plugin_session_start: 'transcript.injection.pluginContext',
  plugin_change: 'transcript.injection.pluginContext',
  plan_mode: 'transcript.injection.planMode',
  permission_mode: 'transcript.injection.permissionMode',
  goal: 'transcript.injection.goalStatus',
  goal_state: 'transcript.injection.goalStatus',
  goal_cancelled: 'transcript.injection.goalCancelled',
  goal_budget_stop: 'transcript.injection.goalBudgetStop',
  goal_fork_cleared: 'transcript.injection.goalForkCleared',
  todo_list_reminder: 'transcript.injection.todoListReminder',
  todo_state: 'transcript.injection.todoState',
  background_task_status: 'transcript.injection.backgroundTaskStatus',
  shell_command_backgrounded: 'transcript.injection.shellCommandBackgrounded',
  interruption: 'transcript.injection.interruption',
  message_delivery: 'transcript.injection.messageDelivery',
  compaction_elision: 'transcript.injection.compactionElision',
  image_compression: 'transcript.injection.imageCompression',
  date_change: 'transcript.injection.dateChange',
  mesh_context: 'transcript.injection.meshContext',
  btw: 'transcript.injection.btw',
  init: 'transcript.injection.init',
  room_joined: 'transcript.injection.roomJoined',
  room_left: 'transcript.injection.roomLeft',
  extension_recovery: 'transcript.injection.extensionRecovery',
  system_reminder: 'transcript.systemReminder',
  task: 'transcript.injection.taskNotification',
  agent_message: 'transcript.injection.agentMessage',
};

export interface ResolvedInjectionHeading {
  readonly labelKey: I18nKey;
  readonly secondary?: string;
  readonly verbatimSource?: string;
}

function shortSuffix(suffix: string): string | undefined {
  const trimmed = suffix.trim();
  if (trimmed === '') return undefined;
  return trimmed.length <= 32 ? trimmed : `${trimmed.slice(0, 31)}…`;
}

function unwrapRecordedPreambleVariant(raw: string): string {
  if (raw.startsWith('injection:')) {
    const inner = raw.slice('injection:'.length);
    return inner.trim();
  }
  return raw;
}

export function resolveInjectionHeading(input: {
  readonly category?: ReminderCategory;
  readonly variant?: string;
  readonly fallbackSource?: string;
}): ResolvedInjectionHeading {
  const rawVariant = input.variant?.trim();
  const verbatimSource = rawVariant !== undefined && rawVariant !== ''
    ? rawVariant
    : input.fallbackSource?.trim() || undefined;

  if (input.category !== undefined) {
    return {
      labelKey: CONTINUITY_CATEGORY_KEYS[input.category.kind],
      verbatimSource,
    };
  }

  if (rawVariant === undefined || rawVariant === '') {
    return {
      labelKey: 'transcript.systemReminder',
      verbatimSource,
    };
  }

  const candidate = unwrapRecordedPreambleVariant(rawVariant);
  if (candidate === '') {
    return {
      labelKey: 'transcript.systemReminder',
      verbatimSource,
    };
  }

  const exact = EXACT_VARIANT_KEYS[candidate];
  if (exact !== undefined) {
    return {
      labelKey: exact,
      verbatimSource,
    };
  }

  if (candidate.startsWith('plugin_extension/')) {
    const suffix = candidate.slice('plugin_extension/'.length).trim();
    if (suffix !== '') {
      return {
        labelKey: 'transcript.injection.pluginContext',
        verbatimSource,
      };
    }
    return {
      labelKey: 'transcript.systemReminder',
      verbatimSource,
    };
  }

  if (candidate.startsWith('hook_rule/')) {
    const suffix = candidate.slice('hook_rule/'.length).trim();
    if (suffix !== '') {
      return {
        labelKey: 'transcript.injection.hookRule',
        secondary: shortSuffix(suffix),
        verbatimSource,
      };
    }
    return {
      labelKey: 'transcript.systemReminder',
      verbatimSource,
    };
  }

  if (candidate.startsWith('hook/')) {
    const suffix = candidate.slice('hook/'.length).trim();
    if (suffix !== '') {
      return {
        labelKey: 'transcript.injection.hookEvent',
        secondary: shortSuffix(suffix),
        verbatimSource,
      };
    }
    return {
      labelKey: 'transcript.systemReminder',
      verbatimSource,
    };
  }

  return {
    labelKey: 'transcript.systemReminder',
    verbatimSource,
  };
}
