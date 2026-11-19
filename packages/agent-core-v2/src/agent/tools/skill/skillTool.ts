import { randomUUID } from 'node:crypto';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { assertPluginSkillUsage } from '#/agent/skill/pluginSkillUsage';
import { ErrorCodes, isError2 } from '#/errors';
import { IAgentRuntimeService, inspectAgentRuntime, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import type { Runtime } from '#/runtime/runtime';
import { resolvePathAccessPath } from '#/tool/path-access';
import { ToolAccesses } from '#/tool/toolContract';
import { isPromptCommandPath, parseSkillText } from '#/app/skillCatalog/parser';
import type { SkillCatalog, SkillDefinition } from '#/app/skillCatalog/types';

import type { ContextMessage, SkillActivationOrigin } from '#/agent/contextMemory/types';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentSkillService } from '#/agent/skill/skill';
import { renderModelToolSkillPrompt } from '#/agent/skill/prompt';
import type { ExecutableToolResult, ToolDeliveryMessage, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { isInlineSkillType } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject, matchesStringRuleSubject } from '#/tool/rule-match';

import {
  ISkillTool,
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillToolInputSchema,
  type SkillToolInput,
} from './skill';
import skillDescriptionTemplate from './skill.md?raw';

export class SkillTool implements ISkillTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Skill';
  readonly description: string = skillDescriptionTemplate;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SkillToolInputSchema, (schema) => {
    schema['oneOf'] = [{ required: ['skill'] }, { required: ['path'] }];
  });

  private queryDepth: number = 0;

  constructor(
    @ISessionSkillCatalog private readonly catalog: ISessionSkillCatalog,
    @IAgentSkillService private readonly skill: IAgentSkillService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IPluginService private readonly plugins?: IPluginService,
    @IPluginUsageService private readonly usage?: IPluginUsageService,
    @ref(IAgentContextMemoryService) private readonly contextMemory?: LiveRef<IAgentContextMemoryService>,
  ) {}

  async resolveExecution(args: SkillToolInput): Promise<ToolExecution> {
    if ((args.skill !== undefined) === (args.path !== undefined)) return { isError: true, output: 'Pass exactly one of skill or path.' };
    const label = args.skill ?? args.path!;
    if (args.path === undefined) return {
      description: `Invoke skill ${label}`,
      display: { kind: 'skill_call', skill_name: label, args: args.args },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesStringRuleSubject(ruleArgs, label),
      execute: () => this.execution(args),
    };
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, inspectAgentWorkspaceRoots(this.runtime, this.workspace));
    const pathOptions = {
      env: inspected.environment,
      workspace: { workspaceDir: view.workDir, additionalDirs: view.additionalDirs },
      operation: 'read' as const,
    };
    const lexicalPath = resolvePathAccessPath(args.path, pathOptions);
    view.resolve(lexicalPath, view.workDir, true);
    const preparation = this.runtime.acquire(['fs']);
    let path: string;
    try {
      if (preparation.runtime.identity.generation !== inspected.identity.generation) return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
      path = resolvePathAccessPath(await preparation.runtime.fs!.realpath(lexicalPath), pathOptions);
      view.resolve(path, view.workDir, true);
    } finally {
      preparation.dispose();
    }
    return {
      description: `Load skill file ${path}`,
      display: { kind: 'skill_call', skill_name: path, args: args.args },
      accesses: ToolAccesses.readFile(path),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, path),
      execute: async () => {
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) return errorResult('Runtime changed before execution. Retry the tool call.');
          const actualPath = resolvePathAccessPath(await lease.runtime.fs!.realpath(lexicalPath), pathOptions);
          view.resolve(actualPath, view.workDir, true);
          if ((inspected.environment.pathClass === 'win32' ? actualPath.toLowerCase() : actualPath) !==
            (inspected.environment.pathClass === 'win32' ? path.toLowerCase() : path)) {
            return errorResult(`Skill file target changed after path admission: admitted "${path}", actual "${actualPath}". Use the actual absolute path or resolve a changed link first.`);
          }
          try {
            await assertPluginSkillUsage(
              actualPath,
              this.sessionContext.workspaceId,
              this.plugins,
              this.usage,
              this.sessionContext.sessionId,
            );
          }
          catch (error) { if (isError2(error)) return errorResult(error.message); throw error; }
          await this.catalog.ready;
          for (const command of await canonicalPromptCommandPaths(this.catalog.catalog, lease.runtime)) {
            const commandPath = resolvePathAccessPath(command.path, pathOptions);
            if (commandPath === actualPath) return errorResult(`Skill "${command.name}" can only be triggered by the user (model invocation is disabled).`);
          }
          const definition = parseSkillText({
            skillMdPath: actualPath,
            skillDirName: inspected.path.basename(actualPath) === 'SKILL.md'
              ? inspected.path.basename(inspected.path.dirname(actualPath))
              : inspected.path.basename(actualPath).replace(/\.md$/i, ''),
            source: 'extra',
            promptCommand: isPromptCommandPath(lexicalPath),
            text: await lease.runtime.fs!.readText(actualPath),
          });
          if (this.catalog.catalog.isSkillDisabled?.(definition.name) === true) {
            return errorResult(`Skill "${definition.name}" is disabled.`);
          }
          return await executeModelSkill(this.catalog, this.skill, args, this.effectiveQueryDepth(), this.sessionContext.sessionId, definition);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  withInitialQueryDepth(initialQueryDepth: number): SkillTool {
    const clone = new SkillTool(this.catalog, this.skill, this.sessionContext, this.runtime, this.workspace, this.plugins, this.usage, this.contextMemory);
    clone.queryDepth = initialQueryDepth;
    return clone;
  }

  private effectiveQueryDepth(): number {
    return Math.max(this.queryDepth, consecutiveSkillChainDepth(this.contextMemory?.current?.get()));
  }

  private async execution(args: SkillToolInput): Promise<ExecutableToolResult> {
    await this.catalog.ready;
    const definition = args.skill === undefined ? undefined : this.catalog.catalog.getSkill(args.skill);
    if (definition !== undefined) {
      try {
        await assertPluginSkillUsage(
          definition.path,
          this.sessionContext.workspaceId,
          this.plugins,
          this.usage,
          this.sessionContext.sessionId,
        );
      }
      catch (error) { if (isError2(error)) return errorResult(error.message); throw error; }
    }
    return executeModelSkill(this.catalog, this.skill, args, this.effectiveQueryDepth(), this.sessionContext.sessionId);
  }
}

registerAgentToolService(ISkillTool, SkillTool, { name: 'Skill', domain: 'skill' });

function consecutiveSkillChainDepth(messages: readonly ContextMessage[] | undefined): number {
  if (messages === undefined || messages.length === 0) return 0;
  const isInjection = (msg: ContextMessage): boolean =>
    msg.origin?.kind === 'injection' ||
    msg.origin?.kind === 'retry' ||
    (msg.role === 'assistant' && msg.toolCalls.length === 0 && msg.content.every((part) => part.type === 'think'));
  let i = messages.length - 1;
  while (i >= 0 && isInjection(messages[i]!)) i -= 1;
  let currentStepCursor = i;
  while (currentStepCursor >= 0 && (isInjection(messages[currentStepCursor]!) || messages[currentStepCursor]!.role === 'tool')) {
    currentStepCursor -= 1;
  }
  if (
    currentStepCursor >= 0 &&
    messages[currentStepCursor]!.role === 'assistant' &&
    messages[currentStepCursor]!.toolCalls.some((tc) => tc.name === 'Skill')
  ) {
    i = currentStepCursor - 1;
  }
  let depth = 0;
  while (i >= 0) {
    while (i >= 0 && isInjection(messages[i]!)) i -= 1;
    if (i < 0) break;
    const candidate = messages[i]!;
    if (candidate.role === 'user' && candidate.origin?.kind === 'skill_activation') {
      while (
        i >= 0 &&
        (isInjection(messages[i]!) || (messages[i]!.role === 'user' && messages[i]!.origin?.kind === 'skill_activation'))
      ) {
        i -= 1;
      }
      depth += 1;
      while (i >= 0 && isInjection(messages[i]!)) i -= 1;
      if (i >= 0 && messages[i]!.role === 'tool') {
        while (i >= 0 && (isInjection(messages[i]!) || messages[i]!.role === 'tool')) i -= 1;
        if (i >= 0 && messages[i]!.role === 'assistant') i -= 1;
        continue;
      }
      break;
    }
    if (candidate.role === 'tool') {
      while (i >= 0 && (isInjection(messages[i]!) || messages[i]!.role === 'tool')) i -= 1;
      const stepAssistant = i >= 0 ? messages[i] : undefined;
      if (
        stepAssistant?.role === 'assistant' &&
        stepAssistant.toolCalls.length > 0 &&
        stepAssistant.toolCalls.every((tc) => tc.name === 'Skill')
      ) {
        i -= 1;
        continue;
      }
      break;
    }
    if (candidate.role === 'user' && candidate.origin?.kind === 'user' && (candidate.origin.skillActivations?.length ?? 0) > 0) {
      depth += 1;
    }
    break;
  }
  return depth;
}

export async function executeModelSkill(
  catalog: ISessionSkillCatalog,
  skillService: IAgentSkillService,
  args: SkillToolInput,
  queryDepth: number,
  sessionId: string,
  explicitDefinition?: SkillDefinition,
): Promise<ExecutableToolResult> {
  const currentDepth = queryDepth;
  if (currentDepth >= MAX_SKILL_QUERY_DEPTH) {
    throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill ?? args.path);
  }

  await catalog.ready;
  const skill = explicitDefinition ?? (args.skill === undefined ? undefined : catalog.catalog.getSkill(args.skill));
  if (skill === undefined) {
    return errorResult(`Skill "${args.skill}" not found in the current skill listing.`);
  }
  if (skill.metadata.disableModelInvocation === true) {
    return errorResult(
      `Skill "${skill.name}" can only be triggered by the user (model invocation is disabled).`,
    );
  }
  if (!isInlineSkillType(skill.metadata.type)) {
    return errorResult(
      `Skill "${skill.name}" is not an inline skill and cannot be invoked by the model in v1.`,
    );
  }

  const skillArgs = args.args ?? '';
  const trigger = currentDepth > 0 ? 'nested-skill' : 'model-tool';
  const origin: SkillActivationOrigin = {
    kind: 'skill_activation',
    activationId: randomUUID(),
    skillName: skill.name,
    skillArgs: skillArgs.length > 0 ? skillArgs : undefined,
    trigger,
    skillType: skill.metadata.type,
    skillPath: skill.path,
    skillSource: skill.source,
  };
  const skillContent = catalog.catalog.renderSkillPrompt(skill, skillArgs, { sessionId });
  const message: ToolDeliveryMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: renderModelToolSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
          skillPath: args.path === undefined ? undefined : skill.path,
          trigger,
        }),
      },
    ],
    toolCalls: [],
    origin,
  };
  skillService.recordModelToolActivation(origin);
  return {
    output: `Skill "${skill.name}" loaded.`,
    delivery: { kind: 'steer', message },
  };
}

interface PromptCommandPath {
  readonly name: string;
  readonly path: string;
}

function canonicalPromptCommandPaths(
  catalog: SkillCatalog,
  runtime: Runtime,
): Promise<readonly PromptCommandPath[]> {
  return Promise.all(
    catalog.listSkills()
      .filter((entry) => entry.metadata.promptCommand === true && entry.source !== 'builtin')
      .map(async (entry): Promise<PromptCommandPath | undefined> => {
        try {
          return { name: entry.name, path: await runtime.fs!.realpath(entry.path) };
        } catch (error) {
          if (isError2(error) && (error.code === ErrorCodes.OS_FS_NOT_FOUND || error.code === ErrorCodes.OS_FS_NOT_DIRECTORY)) return undefined;
          throw error;
        }
      }),
  ).then((entries) => entries.filter((entry): entry is PromptCommandPath => entry !== undefined));
}

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}
