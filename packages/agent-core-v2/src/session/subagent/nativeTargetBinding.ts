import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import type { ExecutionBinding } from '@kiki/protocol';
import type { IConfigService } from '#/app/config/config';
import type { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { AGENT_EXECUTOR_OVERRIDES_SECTION, type AgentExecutorOverridesConfig } from '#/app/agentExecutor/executorOverrides';
import { resolveExecutionBinding } from '#/agent/profile/executionBinding';
import { Error2, ErrorCodes } from '#/errors';
import { assertSubagentModelNotDenied, SUBAGENT_SECTION, type SubagentConfig } from './configSection';
import { roleBindingAdvisories, roleConstraintsFromProfile } from './modelConstraints';

export function resolveNativeTargetBinding(
  profile: AgentProfile,
  input: {
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
    readonly executorInstance?: import('@kiki/protocol').ExecutorInstanceChoice;
    readonly executorLaunch?: import('@kiki/protocol').ExecutorLaunchPatch;
  },
  config: IConfigService,
  executors: IAgentExecutorRegistry,
  retainedExecution?: ExecutionBinding,
): { readonly execution: ExecutionBinding; readonly bindingAdvisories: ReturnType<typeof roleBindingAdvisories> } {
  const executor = profile.executor!;
  const defaults = config.get<AgentExecutorOverridesConfig>(AGENT_EXECUTOR_OVERRIDES_SECTION)?.[executor]?.defaults;
  const execution = retainedExecution ?? resolveExecutionBinding({ executor, overrides: {
    model: input.modelAlias ?? profile.modelAlias,
    thinking: input.thinkingEffort ?? profile.thinkingEffort,
    executor_instance: input.executorInstance,
    executor_launch: input.executorLaunch,
  } }, defaults, undefined, undefined);
  if (execution.effective.model === 'inherit') throw new Error2(ErrorCodes.CONFIG_INVALID,
    'A native engine target cannot inherit a Kiki model. Select the engine default or an explicit vendor model.');
  const resolved = executors.resolve(executor);
  const validated = executors.validateBinding(executor, resolved.options, {
    modelAlias: execution.effective.model, thinkingEffort: execution.effective.thinking,
  });
  if (!validated.ok) throw new Error2(ErrorCodes.CONFIG_INVALID, validated.diagnostic);
  const model = validated.binding.modelAlias;
  const thinking = validated.binding.thinkingEffort;
  const globalDenied = config.get<SubagentConfig>(SUBAGENT_SECTION)?.denyModels;
  if (model === undefined && (profile.allowedModels !== undefined || Boolean(profile.denyModels?.length)
    || profile.restrictModelsToMenu === true || Boolean(globalDenied?.length))) {
    throw new Error2(ErrorCodes.PROFILE_CONSTRAINT_VIOLATION,
      'The engine default model cannot be verified against the caller constraint. Select an explicit permitted vendor model.');
  }
  if (thinking === undefined && profile.allowedEfforts !== undefined) throw new Error2(ErrorCodes.PROFILE_CONSTRAINT_VIOLATION,
    'The engine default effort cannot be verified against the caller constraint. Select an explicit permitted effort.');
  const bindingAdvisories = roleBindingAdvisories({
    model: model ?? '', thinking, requestedModel: execution.effective.model, requestedThinking: execution.effective.thinking,
    constraints: roleConstraintsFromProfile(profile), ruleSource: `target:${profile.name}`,
    modelValueSource: input.modelAlias === undefined ? 'model-default' : 'dispatch-explicit',
    thinkingValueSource: input.thinkingEffort === undefined ? 'model-default' : 'dispatch-explicit',
  });
  if (model !== undefined) assertSubagentModelNotDenied(config, model);
  return { execution, bindingAdvisories };
}
