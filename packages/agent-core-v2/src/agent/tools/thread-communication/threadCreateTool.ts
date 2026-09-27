import { isAbsolute } from 'node:path';
import { z } from 'zod';

import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { constrainPermissionMode, IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentPlanService } from '#/features/plan/plan';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { promptPermissionModeSchema } from '#/app/sessionLegacy/sessionProtocol';
import { CREATED_BY_AGENT_ID_KEY, CREATED_BY_SESSION_ID_KEY } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { normalizeSubagentBindingValue } from '#/session/subagent/configSection';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';

import THREAD_CREATE_DESCRIPTION from './thread-create.md?raw';

export const ThreadCreateToolInputSchema = z.object({
  title: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  model_alias: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  prompt: z.string().min(1).max(100_000).optional(),
}).strict();

type ThreadCreateToolInput = z.infer<typeof ThreadCreateToolInputSchema>;

export interface IThreadCreateTool extends AgentTool<ThreadCreateToolInput> {
  readonly _serviceBrand: undefined;
}

export const IThreadCreateTool = createDecorator<IThreadCreateTool>('threadCreateTool');

export class ThreadCreateTool implements IThreadCreateTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ThreadCreate';
  readonly description = THREAD_CREATE_DESCRIPTION;
  readonly parameters = toInputJsonSchema(ThreadCreateToolInputSchema);

  constructor(
    @ISessionManager private readonly sessions: ISessionManager,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly caller: IAgentScopeContext,
    @IAgentPermissionModeService private readonly callerPermission: IAgentPermissionModeService,
  ) {}

  resolveExecution(input: ThreadCreateToolInput): ToolExecution {
    if (input.cwd !== undefined && !isAbsolute(input.cwd)) {
      return { output: 'cwd must be an absolute path to an existing directory.', isError: true };
    }
    if (input.prompt !== undefined && input.prompt.trim() === '') {
      return { output: 'prompt must contain non-whitespace text.', isError: true };
    }
    return {
      approvalRule: this.name,
      description: 'Creating a new thread',
      execute: async () => {
        const callerMode = this.callerPermission.mode;
        const requestedMode = input.permission_mode ?? callerMode;
        if (constrainPermissionMode(requestedMode, callerMode) !== requestedMode) {
          return { output: `permission_mode ${requestedMode} exceeds the caller's effective ${callerMode} mode. Ask the user to change the caller's mode first.`, isError: true };
        }
        const model = normalizeSubagentBindingValue(input.model_alias, 'model_alias');
        const thinking = normalizeSubagentBindingValue(input.effort, 'effort');
        const handle = await this.sessions.create({
          workDir: input.cwd ?? this.session.cwd,
          mainAgentBinding: input.profile === undefined && model === undefined && thinking === undefined
            ? undefined
            : {
                profile: input.profile ?? DEFAULT_AGENT_PROFILE_NAME,
                model,
                thinking,
                strictThinking: thinking !== undefined,
              },
        });
        let promptAccepted = false;
        try {
          const catalog = handle.accessor.get(ISessionAgentProfileCatalog);
          await catalog.ready;
          const profile = input.profile === undefined ? catalog.getDefault() : catalog.get(input.profile);
          if (profile === undefined) {
            throw new Error2(
              ErrorCodes.PROFILE_UNKNOWN,
              `Agent profile "${input.profile}" is unavailable or disabled. Choose an enabled main-agent profile.`,
            );
          }
          if (profile.main !== true) {
            throw new Error2(
              ErrorCodes.REQUEST_INVALID,
              `Agent profile "${profile.name}" is not a main-agent profile. Choose an enabled main-agent profile.`,
            );
          }
          const firstLine = input.prompt?.split(/\r?\n/, 1)[0]?.trim();
          const title = input.title ?? (firstLine ? Array.from(firstLine).slice(0, 80).join('') : undefined);
          const metadata = handle.accessor.get(ISessionMetadata);
          if (title !== undefined) await metadata.setTitle(title);
          await metadata.update({
            custom: {
              ...(await metadata.read()).custom,
              [CREATED_BY_SESSION_ID_KEY]: this.session.sessionId,
              [CREATED_BY_AGENT_ID_KEY]: this.caller.agentId,
            },
          }, { touchUpdatedAt: false });
          const main = await ensureMainAgent(handle);
          main.accessor.get(IAgentPermissionModeService).setModeCeiling(callerMode);
          main.accessor.get(IAgentLifecycleService).broadcastPermissionMode(requestedMode);
          if (input.plan_mode !== undefined) {
            const plan = main.accessor.get(IAgentPlanService);
            const active = (await plan.status()) !== null;
            if (active !== input.plan_mode) {
              if (input.plan_mode) await plan.enter();
              else plan.exit();
            }
          }
          if (input.prompt !== undefined) {
            const submitted = await main.accessor.get(IAgentPromptService).enqueue({
              message: {
                role: 'user',
                content: [{ type: 'text', text: input.prompt }],
                toolCalls: [],
                origin: { kind: 'user' },
              },
            });
            promptAccepted = true;
            if (await submitted.launched === undefined) {
              const completion = await submitted.completion;
              throw new Error2(
                ErrorCodes.REQUEST_INVALID,
                `Thread "${handle.id}" accepted the prompt but could not start it (${completion.state}).`,
              );
            }
          }
          const created = await metadata.read();
          const context = handle.accessor.get(ISessionContext);
          return {
            output: JSON.stringify({
              id: handle.id,
              title: created.title ?? 'Untitled session',
              cwd: context.cwd,
              profile: profile.name,
              prompt_started: input.prompt !== undefined,
              message: 'Thread created in the session list. It runs independently and does not report back here; to continue it, use ThreadList for its thread reference, then ThreadSend and ThreadWait (requires thread communication to be enabled).',
            }, null, 2),
          };
        } catch (error) {
          if (!promptAccepted) await this.sessions.delete(handle.id);
          throw error;
        }
      },
    };
  }
}

function mainAgentOnly(accessor: ServicesAccessor): boolean {
  return accessor.get(IAgentScopeContext).agentId === 'main';
}

registerAgentToolService(IThreadCreateTool, ThreadCreateTool, {
  name: 'ThreadCreate',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
