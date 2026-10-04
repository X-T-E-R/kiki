import type { ReplayableStateKey } from '#/state/state';

import { contextMemoryKey, contextRevisionKey } from '#/agent/contextMemory/contextOps';
import { modelSwitchCompletionsKey, modelSwitchContinuityKey } from '#/agent/modelSwitch/modelSwitchOps';
import { staleGuardKey } from '#/features/staleGuard/staleGuardOps';
import { fullCompactionKey } from '#/agent/fullCompaction/compactionOps';
import { autoCompactOverrideKey } from '#/agent/fullCompaction/autoCompactOps';
import { contextStrategyOverrideKey } from '#/agent/fullCompaction/contextStrategyOps';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { goalKey } from '#/agent/goal/goalOps';
import { goalForkNoticeKey } from '#/agent/goal/goalService';
import { interruptionReminderKey } from '#/agent/interruptionReminder/interruptionReminderOps';
import { llmRequestTraceKey } from '#/agent/llmRequester/llmRequestOps';
import { turnKey } from '#/agent/loop/turnOps';
import { mcpDiscoveryKey } from '#/agent/mcp/mcpDiscoveryOps';
import {
  permissionModeConfiguredKey,
  permissionModeKey,
} from '#/agent/permissionMode/permissionModeOps';
import { permissionRulesKey } from '#/agent/permissionRules/permissionRulesOps';
import { pluginSessionStartSnapshotKey } from '#/agent/plugin/agentPluginOps';
import { promptAdmissionKey, promptRetryReceiptKey } from '#/agent/prompt/promptOps';
import { promptIdentityKey, promptQueueKey, promptResolutionKey } from '#/agent/prompt/promptService';
import { modelSwitchQueueKey } from '#/agent/prompt/modelSwitchQueueOps';
import { profileActiveToolsKey, profileKey } from '#/agent/profile/profileOps';
import { runtimeBindingKey } from '#/agent/runtimeBinding/runtimeBindingOps';
import { skillKey } from '#/agent/skill/skillOps';
import { taskKey } from '#/agent/task/taskOps';
import { taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { tokenCountingKey } from '#/agent/tokenCounting/tokenCountingOps';
import { usageKey } from '#/agent/usage/usageOps';
import { panelAccountingKey } from '#/agent/usage/panelAccounting';
import { userToolKey } from '#/agent/userTool/userToolOps';
import { planKey } from '#/features/plan/planOps';
import { agentMessageMaterializationsKey, agentMessageReceiptsKey } from '#/session/agentCollaboration/messageReceiptState';
import { cronKey } from '#/session/cron/cronOps';
import { interactionKey } from '#/session/interaction/interactionOps';
import { todoKey } from '#/session/todo/todoOps';
import { continuityClockKey } from '#/session/todo/continuityState';
import { dynamicPromptKey } from '#/agent/profile/dynamicPrompt';
import { hookStateKey } from '#/features/externalHooks/agent/hookState';

export const BUILTIN_REPLAYABLE_STATE_KEYS: readonly ReplayableStateKey<any>[] = [
  contextMemoryKey,
  contextRevisionKey,
  modelSwitchCompletionsKey,
  modelSwitchContinuityKey,
  staleGuardKey,
  fullCompactionKey,
  autoCompactOverrideKey,
  contextStrategyOverrideKey,
  contextWindowEpochKey,
  goalKey,
  goalForkNoticeKey,
  interruptionReminderKey,
  llmRequestTraceKey,
  turnKey,
  mcpDiscoveryKey,
  permissionModeKey,
  permissionModeConfiguredKey,
  permissionRulesKey,
  pluginSessionStartSnapshotKey,
  promptAdmissionKey,
  promptRetryReceiptKey,
  promptResolutionKey,
  promptIdentityKey,
  promptQueueKey,
  modelSwitchQueueKey,
  profileKey,
  profileActiveToolsKey,
  runtimeBindingKey,
  skillKey,
  taskKey,
  taskNotificationDeliveryKey,
  tokenCountingKey,
  usageKey,
  panelAccountingKey,
  userToolKey,
  planKey,
  agentMessageReceiptsKey,
  agentMessageMaterializationsKey,
  cronKey,
  interactionKey,
  todoKey,
  continuityClockKey,
  dynamicPromptKey,
  hookStateKey,
];
