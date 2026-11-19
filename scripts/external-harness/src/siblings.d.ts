declare module '*/agy-mcp-plugin.mjs' {
  export interface McpServerConfig {
    name: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  }

  export interface RegisteredMcpPlugin {
    name: string;
    path: string;
    env: Record<string, string>;
    beforeLaunch(): Promise<void>;
    launched(pid: number | undefined): Promise<void>;
    close(): Promise<void>;
  }

  export function registerProjectMcpPlugin(options: {
    cwd: string;
    sessionId: string;
    namespace?: string;
    nodePath: string;
    handlerPath: string;
    servers: McpServerConfig[];
  }): Promise<RegisteredMcpPlugin>;

  export function recoverProjectMcpPlugin(options: {
    cwd: string;
    sessionId: string;
  }): Promise<unknown>;

  export function recoverDeadProjectMcpPlugins(options: {
    cwd: string;
  }): Promise<unknown[]>;
}

declare module '*/agy-hook-registration.mjs' {
  export const AGY_PERMISSION_HOOK_KEY: string;
  export const AGY_STEERING_HOOK_KEY: string;
  export const AGY_COMMAND_GUIDANCE_HOOK_KEY: string;

  export interface RegisteredProjectHook {
    close(): Promise<void>;
  }

  export function registerProjectHook(options: {
    cwd: string;
    nodePath: string;
    handlerPath: string;
    sessionId: string;
    key: string;
    args?: string[];
  }): Promise<RegisteredProjectHook>;

  export function recoverProjectHook(options: {
    cwd: string;
    nodePath: string;
    handlerPath: string;
  }): Promise<{ status: string }>;
}

declare module '*/agy-permission-hook.mjs' {
  export interface PermissionChannelIdentity {
    KIKI_AGY_PERMISSION_ENDPOINT: string;
    KIKI_AGY_PERMISSION_TOKEN: string;
  }

  export interface PermissionResponse {
    decision: 'allow' | 'deny' | 'ask';
    reason?: string;
    steering?: { injectSteps: Array<{ userMessage: string }> };
    afterWrite?: () => void;
    afterFailure?: () => void;
  }

  export interface PermissionChannel {
    env: PermissionChannelIdentity;
    close(): Promise<void>;
  }

  export function permissionChannelIdentity(): PermissionChannelIdentity;

  export function openPermissionChannel(
    handle: (input: Record<string, unknown>) => Promise<PermissionResponse> | PermissionResponse,
    identity?: PermissionChannelIdentity,
  ): Promise<PermissionChannel>;

  export function requestHookPermission(
    payload: Record<string, unknown>,
    env?: NodeJS.ProcessEnv,
    timeoutMs?: number,
  ): Promise<PermissionResponse>;
}
