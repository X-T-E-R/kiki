import { isAbsolute } from 'node:path';
import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { constrainPermissionMode, IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentProfileService } from '#/agent/profile/profile';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentPlanService } from '#/features/plan/plan';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { promptPermissionModeSchema } from '#/app/sessionLegacy/sessionProtocol';
import { CREATED_BY_AGENT_ID_KEY, CREATED_BY_SESSION_ID_KEY } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IThreadCommunicationService } from '#/app/threadCommunication/threadCommunication';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
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
  from_subagent: z.string().trim().min(1).optional(),
  profile: z.string().min(1).optional(),
  persona: z.string().trim().min(1).optional(),
  model_alias: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  prompt: z.string().min(1).max(100_000).optional(),
  bridge_id: z.string().uuid().optional(),
  connection_id: z.string().uuid().optional(),
  workspace_id: z.string().min(1).max(512).optional(),
  idempotency_key: z.string().min(1).max(256).optional(),
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
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IThreadCommunicationService private readonly threadCommunication: IThreadCommunicationService,
  ) {}

  resolveExecution(input: ThreadCreateToolInput): ToolExecution {
    const bridged = input.bridge_id !== undefined || input.connection_id !== undefined || input.workspace_id !== undefined;
    if (bridged && input.cwd !== undefined) {
      return { output: 'cwd cannot be specified when creating a thread in another space; the target bridge workspace is used.', isError: true };
    }
    if (bridged && input.from_subagent !== undefined) {
      return { output: 'from_subagent only promotes a local subagent and cannot be used across spaces.', isError: true };
    }
    if (input.cwd !== undefined && !isAbsolute(input.cwd)) {
      return { output: 'cwd must be an absolute path to an existing directory.', isError: true };
    }
    if (input.prompt !== undefined && input.prompt.trim() === '') {
      return { output: 'prompt must contain non-whitespace text.', isError: true };
    }
    if (input.from_subagent !== undefined && input.cwd !== undefined) {
      return { output: 'from_subagent keeps the subagent\'s own working directory; omit cwd.', isError: true };
    }
    if (input.from_subagent !== undefined && input.persona !== undefined) {
      return { output: 'from_subagent cannot be combined with persona.', isError: true };
    }
    return {
      approvalRule: this.name,
      description: bridged ? 'Creating a thread in another space' : input.from_subagent === undefined ? 'Creating a new thread' : `Opening subagent ${input.from_subagent} as a thread`,
      execute: async ({ signal, toolCallId }) => {
        const callerMode = this.callerPermission.mode;
        const requestedMode = input.permission_mode ?? (bridged ? constrainPermissionMode(callerMode, 'auto') : callerMode);
        if (bridged && constrainPermissionMode(requestedMode, 'auto') !== requestedMode) {
          return { output: `permission_mode ${requestedMode} exceeds the cross-space auto ceiling.`, isError: true };
        }
        if (constrainPermissionMode(requestedMode, callerMode) !== requestedMode) {
          return { output: `permission_mode ${requestedMode} exceeds the caller's effective ${callerMode} mode. Ask the user to change the caller's mode first.`, isError: true };
        }
        if (bridged) {
          const created = await this.threadCommunication.createThread({
            caller: { workspaceId: this.session.workspaceId, sessionId: this.session.sessionId },
            bridgeId: input.bridge_id, connectionId: input.connection_id, workspaceId: input.workspace_id,
            idempotencyKey: input.idempotency_key ?? toolCallId, signal,
            title: input.title, profile: input.profile, persona: input.persona, modelAlias: input.model_alias,
            effort: input.effort, permissionMode: requestedMode, planMode: input.plan_mode, prompt: input.prompt,
          });
          const ref = created.ref;
          return { output: JSON.stringify({
            id: ref.sessionId,
            thread: { host_id: ref.hostId, workspace_id: ref.workspaceId, session_id: ref.sessionId, bridge_id: ref.bridgeId, connection_id: ref.connectionId },
            title: created.title, profile: created.profile, prompt_started: created.promptStarted,
            message: 'Pass thread directly to ThreadSend, ThreadRead, or ThreadWait when the bridge permits the operation.',
          }, null, 2) };
        }
        const model = normalizeSubagentBindingValue(input.model_alias, 'model_alias');
        const thinking = normalizeSubagentBindingValue(input.effort, 'effort');
        const handle = input.from_subagent !== undefined
          ? await this.promoteSubagent(input.from_subagent, input.title, input.profile, model, thinking)
          : await this.sessions.create({
              workDir: input.cwd ?? this.session.cwd,
              mainAgentBinding: input.profile === undefined && input.persona === undefined && model === undefined && thinking === undefined
                ? undefined
                : {
                    profile: input.profile ?? (input.persona === undefined ? DEFAULT_AGENT_PROFILE_NAME : undefined),
                    persona: input.persona,
                    model,
                    thinking,
                    strictThinking: thinking !== undefined,
                  },
            });
        let promptAccepted = false;
        try {
          const catalog = handle.accessor.get(ISessionAgentProfileCatalog);
          await catalog.ready;
          const main = await ensureMainAgent(handle);
          const profileName = main.accessor.get(IAgentProfileService).data().profileName ?? input.profile;
          const profile = profileName === undefined ? catalog.getDefault() : catalog.get(profileName);
          if (profile === undefined) {
            throw new Error2(
              ErrorCodes.PROFILE_UNKNOWN,
              `Agent profile "${profileName}" is unavailable or disabled. Choose an enabled main-agent profile.`,
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
                origin: { kind: 'system_trigger', name: 'thread_create' },
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

  private async promoteSubagent(
    agentId: string,
    title: string | undefined,
    profile: string | undefined,
    model: string | undefined,
    thinking: string | undefined,
  ): Promise<ISessionScopeHandle> {
    const meta = (await this.metadata.read()).agents?.[agentId];
    if (meta === undefined || subagentParentAgentId(meta) !== this.caller.agentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `"${agentId}" is not a subagent started by this agent. Use AgentList to find the agent id.`,
        { details: { agentId } },
      );
    }
    if (this.sessions.promoteAgent === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Opening a subagent as a thread is unavailable on this host.');
    }
    return this.sessions.promoteAgent({
      sourceSessionId: this.session.sessionId,
      agentId,
      title,
      profile,
      model,
      thinking,
    });
  }
}

registerAgentToolService(IThreadCreateTool, ThreadCreateTool, {
  name: 'ThreadCreate',
  domain: 'threadCommunication',
});
