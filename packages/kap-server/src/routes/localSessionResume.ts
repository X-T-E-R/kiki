import {
  IAgentExecutorRegistry, IFlagService, ILocalSessionCatalog, ISessionIndex, ISessionManager, ISessionMetadata,
  LOCAL_SESSION_RESUME_FLAG, localSessionKikiId, localSourceFromRef,
  type LocalExecutorSessionSource, type Scope,
} from '@kiki/agent-core-v2';
import { ErrorCode, type ResumeLocalSessionRequest, type ResumeLocalSessionResponse } from '@kiki/protocol';

import { acquireWorkspaceProfileCatalog } from './agentProfileCapabilities';

const pending = new WeakMap<Scope, Map<string, Promise<ResumeOutcome>>>();
type ResumeOutcome = ResumeLocalSessionResponse | { readonly error: number; readonly message: string };

export async function resumeLocalSession(core: Scope, executorId: string, localId: string, body: ResumeLocalSessionRequest): Promise<ResumeOutcome> {
  if (!core.accessor.get(IFlagService).enabled(LOCAL_SESSION_RESUME_FLAG)) {
    return { error: ErrorCode.CAPABILITY_UNSUPPORTED, message: 'Local session continuation is disabled' };
  }
  const descriptor = core.accessor.get(IAgentExecutorRegistry).get(executorId);
  if (descriptor === undefined) return { error: ErrorCode.AGENT_PROFILE_NOT_FOUND, message: 'Executor not found' };
  const detail = await core.accessor.get(ILocalSessionCatalog).get(executorId, localId);
  if (detail === undefined) return { error: ErrorCode.SESSION_NOT_FOUND, message: 'Local session was not found' };
  const summary = detail.summary;
  if (!summary.resume.supported) return { error: ErrorCode.CAPABILITY_UNSUPPORTED, message: summary.resume.reason! };
  if (summary.sourceHome !== body.source_home) return { error: ErrorCode.VALIDATION_FAILED, message: 'Local session source home changed' };
  const source: LocalExecutorSessionSource = { localId, executorId, engine: summary.engine, externalId: summary.externalId, home: summary.sourceHome };
  const sessionId = localSessionKikiId(source);
  let operations = pending.get(core);
  if (operations === undefined) { operations = new Map(); pending.set(core, operations); }
  const running = operations.get(sessionId);
  if (running !== undefined) {
    const result = await running;
    return 'error' in result ? result : { ...result, created: false };
  }
  const operation = attach();
  operations.set(sessionId, operation);
  try { return await operation; }
  finally { operations.delete(sessionId); }

  async function attach(): Promise<ResumeOutcome> {
    const existing = await core.accessor.get(ISessionIndex).get(sessionId);
    if (existing !== undefined) {
      const old = localSourceFromRef({ localSource: existing.custom?.['local_session'] });
      if (old?.engine !== source.engine || old.home !== source.home || old.externalId !== source.externalId) {
        return { error: ErrorCode.VALIDATION_FAILED, message: 'Existing Kiki session has a different local source' };
      }
      return { session_id: existing.id, executor_id: old.executorId, created: false };
    }
    const workspace = await acquireWorkspaceProfileCatalog(core, { cwd: summary.cwd! });
    if (workspace === undefined) return { error: ErrorCode.WORKSPACE_NOT_FOUND, message: 'Local working directory is unavailable' };
    try {
      const profile = body.profile === undefined ? workspace.catalog.snapshot().defaultProfile : workspace.catalog.get(body.profile);
      if (profile === undefined || body.profile !== undefined && (profile.executor ?? 'native') !== executorId) {
        return { error: ErrorCode.VALIDATION_FAILED, message: 'Select a profile bound to the selected executor' };
      }
      const resolvedProfile = body.profile === undefined ? {
        ...profile, executor: executorId, executorOptions: undefined,
        modelAlias: undefined, thinkingEffort: undefined,
      } : profile;
      const handle = await core.accessor.get(ISessionManager).create({
        sessionId, workspaceId: workspace.workspaceId, workDir: summary.cwd!, localSession: source,
        mainAgentBinding: { resolvedProfile, model: body.model, thinking: body.thinking },
      });
      const title = summary.title?.trim() || Array.from(summary.lastPrompt?.trim().replace(/\s+/g, ' ') ?? '').slice(0, 80).join('');
      if (title !== '') await handle.accessor.get(ISessionMetadata).setGeneratedTitleIfUncustomized(title);
      return { session_id: handle.id, executor_id: executorId, created: true };
    } finally { workspace.dispose(); }
  }
}
