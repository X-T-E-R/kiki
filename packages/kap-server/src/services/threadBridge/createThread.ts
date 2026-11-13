import {
  DEFAULT_AGENT_PROFILE_NAME, ensureMainAgent, ISessionManager, ISessionAgentProfileCatalog,
  IAgentProfileService, IAgentPermissionModeService, IAgentLifecycleService, IAgentPlanService,
  IAgentPromptService, IEventDispatcher, ISessionMetadata, CREATED_BY_SESSION_ID_KEY, CREATED_BY_AGENT_ID_KEY,
  Error2, ErrorCodes, constrainPermissionMode, type Scope, type Workspace, type CreateBridgedThreadResult,
} from '@kiki/agent-core-v2';
import type { BridgeCreate } from '@kiki/protocol';

export async function createBridgedThread(core: Scope, workspace: Workspace, hostId: string, input: BridgeCreate, sessionId: string, promptId: string): Promise<CreateBridgedThreadResult> {
  const sessions = core.accessor.get(ISessionManager);
  const existing = await sessions.resume(sessionId);
  const handle = existing ?? await sessions.create({
    sessionId, workspaceId: workspace.id, workDir: workspace.root,
    mainAgentBinding: input.profile === undefined && input.persona === undefined && input.modelAlias === undefined && input.effort === undefined
      ? undefined
      : { profile: input.profile ?? (input.persona === undefined ? DEFAULT_AGENT_PROFILE_NAME : undefined),
          persona: input.persona, model: input.modelAlias, thinking: input.effort, strictThinking: input.effort !== undefined },
  });
  let promptAccepted = false;
  try {
    const catalog = handle.accessor.get(ISessionAgentProfileCatalog);
    await catalog.ready;
    const main = await ensureMainAgent(handle);
    const profileName = main.accessor.get(IAgentProfileService).data().profileName ?? input.profile;
    const profile = profileName === undefined ? catalog.getDefault() : catalog.get(profileName);
    if (profile === undefined) throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Agent profile "${profileName}" is unavailable or disabled. Choose an enabled main-agent profile.`);
    if (profile.main !== true) throw new Error2(ErrorCodes.REQUEST_INVALID, `Agent profile "${profile.name}" is not a main-agent profile. Choose an enabled main-agent profile.`);
    const metadata = handle.accessor.get(ISessionMetadata);
    const firstLine = input.prompt?.split(/\r?\n/, 1)[0]?.trim();
    const title = input.title ?? (firstLine ? Array.from(firstLine).slice(0, 80).join('') : undefined);
    if (title !== undefined) await metadata.setTitle(title);
    await metadata.update({ custom: {
      ...(await metadata.read()).custom,
      [CREATED_BY_SESSION_ID_KEY]: `${input.source.hostId}:${input.source.sessionId}`,
      [CREATED_BY_AGENT_ID_KEY]: 'bridged_peer',
    } }, { touchUpdatedAt: false });
    const permission = main.accessor.get(IAgentPermissionModeService);
    const effectiveMode = constrainPermissionMode(input.permissionMode ?? 'auto', 'auto');
    permission.setModeCeiling('auto');
    permission.setMode(effectiveMode);
    main.accessor.get(IAgentLifecycleService).broadcastPermissionMode(effectiveMode);
    if (input.planMode !== undefined) {
      const plan = main.accessor.get(IAgentPlanService);
      if (((await plan.status()) !== null) !== input.planMode) {
        if (input.planMode) await plan.enter();
        else plan.exit();
      }
    }
    await main.accessor.get(IEventDispatcher).flush();
    const createdTitle = (await metadata.read()).title ?? 'Untitled session';
    if (input.prompt !== undefined) {
      promptAccepted = true;
      await main.accessor.get(IAgentPromptService).enqueue({ id: promptId, waitForLaunch: false, message: {
        role: 'user', content: [{ type: 'text', text: input.prompt }], toolCalls: [],
        origin: { kind: 'system_trigger', name: 'thread_create' },
      } });
      await main.accessor.get(IEventDispatcher).flush();
    }
    return { ref: { hostId, workspaceId: workspace.id, sessionId: handle.id },
      title: createdTitle, profile: profile.name, promptStarted: input.prompt !== undefined };
  } catch (error) {
    if (existing === undefined && !promptAccepted) await sessions.delete(handle.id);
    throw error;
  }
}
