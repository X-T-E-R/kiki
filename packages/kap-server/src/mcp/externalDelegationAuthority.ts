import {
  DEFAULT_AGENT_PROFILE_NAME,
  IAgentLifecycleService,
  IAgentProfileService,
  ISessionIndex,
  ISessionLegacyService,
  ISessionManager,
  ISessionMetadata,
  IWorkspaceService,
  resumeSessionById,
  type PermissionMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { realpath } from 'node:fs/promises';
import { platform } from 'node:os';
import { isAbsolute, normalize } from 'node:path';

import { ensureMainAgent } from '../transport/mainAgent';

export interface ExternalDelegationSessionBootstrap {
  readonly workspacePath: string;
  readonly modelAlias: string;
  readonly thinkingEffort: string;
  readonly permissionMode?: PermissionMode;
  readonly title?: string;
}

export interface ExternalDelegationAuthorityConfig {
  readonly principalId: string;
  readonly sessionId: string;
  readonly token: string;
  /**
   * Operator-owned exact Session provisioning. The caller cannot select this
   * value over REST: it is captured from server composition, creates the
   * configured Session id in the configured workspace when absent, and applies
   * an operator-updated signed model/thinking/permission binding to an existing Session.
   */
  readonly sessionBootstrap?: ExternalDelegationSessionBootstrap;
}

const BASE_ENV = [
  'KIKI_EXTERNAL_PRINCIPAL_ID',
  'KIKI_EXTERNAL_SESSION_ID',
  'KIKI_EXTERNAL_DELEGATION_TOKEN',
] as const;
const BOOTSTRAP_ENV = [
  'KIKI_EXTERNAL_WORKSPACE_PATH',
  'KIKI_EXTERNAL_MODEL_ALIAS',
  'KIKI_EXTERNAL_THINKING_EFFORT',
] as const;

export function externalDelegationAuthorityFromEnv(
  env: NodeJS.ProcessEnv,
): ExternalDelegationAuthorityConfig | undefined {
  const base = BASE_ENV.map((name) => env[name]?.trim());
  const bootstrap = BOOTSTRAP_ENV.map((name) => env[name]?.trim());
  const permissionMode = parsePermissionMode(env['KIKI_EXTERNAL_PERMISSION_MODE']?.trim());
  const title = env['KIKI_EXTERNAL_SESSION_TITLE']?.trim();
  const hasBase = base.some((value) => value !== undefined);
  const hasBootstrap =
    bootstrap.some((value) => value !== undefined) ||
    permissionMode !== undefined ||
    title !== undefined;

  if (!hasBase && !hasBootstrap) return undefined;
  if (base.some((value) => value === undefined || value.length === 0)) {
    throw new Error('External delegation authority configuration is incomplete.');
  }
  if (hasBootstrap && bootstrap.some((value) => value === undefined || value.length === 0)) {
    throw new Error('External delegation Session bootstrap configuration is incomplete.');
  }

  const [principalId, sessionId, token] = base as [string, string, string];
  if (!/^session_[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error('External delegation Session id is invalid.');
  }

  return {
    principalId,
    sessionId,
    token,
    sessionBootstrap: hasBootstrap
      ? {
          workspacePath: bootstrap[0] as string,
          modelAlias: bootstrap[1] as string,
          thinkingEffort: bootstrap[2] as string,
          permissionMode,
          title: title === '' ? undefined : title,
        }
      : undefined,
  };
}

function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'manual' || value === 'auto' || value === 'yolo') return value;
  throw new Error('External delegation permission mode is invalid.');
}

export async function ensureExternalDelegationSession(
  core: Scope,
  authority: ExternalDelegationAuthorityConfig | undefined,
): Promise<void> {
  const bootstrap = authority?.sessionBootstrap;
  if (authority === undefined || bootstrap === undefined) return;
  if (!isAbsolute(bootstrap.workspacePath)) {
    throw new Error('External delegation workspace path must be absolute.');
  }

  const expectedWorkspace = await canonicalPath(bootstrap.workspacePath);
  const registry = core.accessor.get(IWorkspaceService);
  const index = core.accessor.get(ISessionIndex);
  const indexStatus = await index.prepare();
  if (indexStatus.source === 'read-model' && indexStatus.state !== 'ready') {
    throw new Error('External delegation Session index is not ready.');
  }
  const existing = await index.get(authority.sessionId);
  if (existing === undefined) {
    const workspace = await registry.createOrTouch(expectedWorkspace);
    const session = await core.accessor.get(ISessionManager).create({
      workspaceId: workspace.id,
      sessionId: authority.sessionId,
      workDir: expectedWorkspace,
      mainAgentBinding: {
        profile: DEFAULT_AGENT_PROFILE_NAME,
        model: bootstrap.modelAlias,
        thinking: bootstrap.thinkingEffort,
        strictThinking: true,
      },
    });
    if (bootstrap.title !== undefined) {
      await session.accessor.get(ISessionMetadata).setTitle(bootstrap.title);
    }
  } else {
    const persistedWorkspace =
      existing.cwd ?? (await registry.get(existing.workspaceId))?.root;
    if (
      persistedWorkspace === undefined ||
      pathKey(await canonicalPath(persistedWorkspace)) !== pathKey(expectedWorkspace)
    ) {
      throw new Error('External delegation Session workspace binding does not match.');
    }
  }

  const legacy = core.accessor.get(ISessionLegacyService);
  let status = await legacy.status(authority.sessionId);
  const updateProfile =
    status.model !== bootstrap.modelAlias ||
    status.thinking_level !== bootstrap.thinkingEffort;
  if (updateProfile || bootstrap.permissionMode !== undefined) {
    const session = await resumeSessionById(core.accessor, authority.sessionId);
    if (session === undefined) {
      throw new Error('External delegation Session is unavailable.');
    }
    const agent = await ensureMainAgent(session);
    if (updateProfile) {
      const profile = agent.accessor.get(IAgentProfileService);
      if (status.model !== bootstrap.modelAlias) {
        await profile.setModel(bootstrap.modelAlias);
      }
      if (status.thinking_level !== bootstrap.thinkingEffort) {
        profile.setThinking(bootstrap.thinkingEffort);
      }
      status = await legacy.status(authority.sessionId);
    }
    if (bootstrap.permissionMode !== undefined) {
      agent.accessor
        .get(IAgentLifecycleService)
        .broadcastPermissionMode(bootstrap.permissionMode);
    }
  }
  if (
    status.model !== bootstrap.modelAlias ||
    status.thinking_level !== bootstrap.thinkingEffort
  ) {
    throw new Error('External delegation Session model binding does not match.');
  }
}

async function canonicalPath(path: string): Promise<string> {
  return normalize(await realpath(path));
}

function pathKey(path: string): string {
  return platform() === 'win32' ? path.toLocaleLowerCase('en-US') : path;
}
