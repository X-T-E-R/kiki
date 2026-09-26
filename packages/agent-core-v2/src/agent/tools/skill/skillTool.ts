import { randomUUID } from 'node:crypto';
import { ErrorCodes, isError2 } from '#/errors';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { resolvePathAccessPath } from '#/tool/path-access';
import { ToolAccesses } from '#/tool/toolContract';
import { isPromptCommandPath, parseSkillText } from '#/app/skillCatalog/parser';
import type { SkillDefinition } from '#/app/skillCatalog/types';

import type { SkillActivationOrigin } from '#/agent/contextMemory/types';
import { IAgentSkillService } from '#/agent/skill/skill';
import { renderModelToolSkillPrompt } from '#/agent/skill/prompt';
import type { ExecutableToolResult, ToolDeliveryMessage, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { isInlineSkillType } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';

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
  readonly description: string = renderPrompt(skillDescriptionTemplate, {
    MAX_SKILL_QUERY_DEPTH,
  });
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
  ) {}

  async resolveExecution(args: SkillToolInput): Promise<ToolExecution> {
    if ((args.skill !== undefined) === (args.path !== undefined)) return { isError: true, output: 'Pass exactly one of skill or path.' };
    const label = args.skill ?? args.path!;
    if (args.path === undefined) return {
      description: `Invoke skill ${label}`,
      display: { kind: 'skill_call', skill_name: label, args: args.args },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, label),
      execute: () => this.execution(args),
    };
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, this.workspace);
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
          if (actualPath !== path) return errorResult('Skill file target changed after path admission. Retry the tool call.');
          await this.catalog.ready;
          for (const entry of this.catalog.catalog.listSkills()) {
            if (entry.metadata.promptCommand !== true || entry.source === 'builtin') continue;
            let canonicalCommandPath: string;
            try {
              canonicalCommandPath = await lease.runtime.fs!.realpath(entry.path);
            } catch (error) {
              if (isError2(error) && (error.code === ErrorCodes.OS_FS_NOT_FOUND || error.code === ErrorCodes.OS_FS_NOT_DIRECTORY)) continue;
              throw error;
            }
            const commandPath = resolvePathAccessPath(canonicalCommandPath, pathOptions);
            if (commandPath === actualPath) return errorResult(`Skill "${entry.name}" can only be triggered by the user (model invocation is disabled).`);
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
          return await executeModelSkill(this.catalog, this.skill, args, this.queryDepth, this.sessionContext.sessionId, definition);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  withInitialQueryDepth(initialQueryDepth: number): SkillTool {
    const clone = new SkillTool(this.catalog, this.skill, this.sessionContext, this.runtime, this.workspace);
    clone.queryDepth = initialQueryDepth;
    return clone;
  }

  private async execution(args: SkillToolInput): Promise<ExecutableToolResult> {
    return executeModelSkill(
      this.catalog,
      this.skill,
      args,
      this.queryDepth,
      this.sessionContext.sessionId,
    );
  }
}

registerAgentToolService(ISkillTool, SkillTool, { name: 'Skill', domain: 'skill' });

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

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}
