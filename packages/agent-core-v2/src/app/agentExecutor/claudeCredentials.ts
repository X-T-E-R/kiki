import { join } from 'pathe';

import type { AgentExecutorCredentialSource } from './agentExecutor';

/**
 * The environment variables Claude Code reads a credential from, ordered the
 * way its own authentication precedence ranks them.
 */
export const CLAUDE_CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * The environment variables that move Claude Code onto a backend whose
 * credentials live outside the CLI: Amazon Bedrock, Google Cloud Vertex AI and
 * Microsoft Foundry.
 */
export const CLAUDE_EXTERNAL_BACKEND_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

export interface ClaudeCredentialsEnv {
  get(name: string): string | undefined;
}

export interface ClaudeCredentialsProbe {
  readonly env: ClaudeCredentialsEnv;
  readonly readText: (path: string) => Promise<string | undefined>;
  /** User-level settings files to read, highest precedence first. */
  readonly settingsPaths: readonly string[];
}

export interface ClaudeCredentialsResult {
  readonly source: AgentExecutorCredentialSource;
  /**
   * Where the credential comes from: an environment-variable name, a settings
   * file path, or a provider name. Never the credential itself, a helper
   * command's output, or any other secret.
   */
  readonly detail?: string;
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function truthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The Claude Code configuration directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: ClaudeCredentialsEnv, osHomeDir: string): string {
  const override = env.get('CLAUDE_CONFIG_DIR');
  return present(override) ? override! : join(osHomeDir, '.claude');
}

/**
 * The Claude Code settings files Kiki reads when judging readiness. Only the
 * user tier is listed: the project tiers (`.claude/settings.json` and
 * `.claude/settings.local.json`) belong to the working directory a session
 * picks later, which a server-wide check cannot know.
 */
export function claudeSettingsPaths(configDir: string): readonly string[] {
  return [join(configDir, 'settings.json')];
}

/** Reads a credential out of a Claude Code settings file's `env` block or its `apiKeyHelper`. */
export function credentialFromClaudeSettings(
  settings: unknown,
  path: string,
): ClaudeCredentialsResult | undefined {
  if (!isRecord(settings)) return undefined;
  const helper = settings['apiKeyHelper'];
  if (typeof helper === 'string' && present(helper)) return { source: 'api_key_helper', detail: path };
  const env = settings['env'];
  if (!isRecord(env)) return undefined;
  for (const name of CLAUDE_CREDENTIAL_ENV_VARS) {
    const value = env[name];
    if (typeof value === 'string' && present(value)) return { source: 'settings_env', detail: `${path}#env.${name}` };
  }
  for (const name of CLAUDE_EXTERNAL_BACKEND_ENV_VARS) {
    const value = env[name];
    if (typeof value === 'string' && truthy(value)) return { source: 'external_backend', detail: `${path}#env.${name}` };
  }
  return undefined;
}

/**
 * Looks for a Claude Code credential the agent process already inherits or the
 * user's own configuration already carries — the environment variables Claude
 * Code reads, then `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR` aware). OAuth
 * state is deliberately absent: it lives in the CLI's credential store and only
 * `claude auth status --json` can report it.
 */
export async function scanClaudeCredentials(
  probe: ClaudeCredentialsProbe,
): Promise<ClaudeCredentialsResult> {
  for (const name of CLAUDE_CREDENTIAL_ENV_VARS) {
    if (present(probe.env.get(name))) return { source: credentialEnvSource(name), detail: name };
  }
  for (const name of CLAUDE_EXTERNAL_BACKEND_ENV_VARS) {
    const value = probe.env.get(name);
    if (value !== undefined && truthy(value)) return { source: 'external_backend', detail: name };
  }
  for (const path of probe.settingsPaths) {
    const text = await probe.readText(path);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const found = credentialFromClaudeSettings(parsed, path);
    if (found !== undefined) return found;
  }
  return { source: 'none' };
}

/**
 * Reads the source out of `claude auth status --json`. Claude Code reports
 * "nothing configured" as `loggedIn: false` rather than as an error, so a
 * successful probe is the only thing that can prove a sign-out.
 */
export function credentialFromClaudeCliStatus(output: string): ClaudeCredentialsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { source: 'unknown' };
  }
  if (!isRecord(parsed)) return { source: 'unknown' };
  const apiProvider = parsed['apiProvider'];
  if (typeof apiProvider === 'string' && apiProvider !== 'firstParty') {
    return { source: 'external_backend', detail: apiProvider };
  }
  const apiKeySource = typeof parsed['apiKeySource'] === 'string' ? parsed['apiKeySource'] : undefined;
  if (apiKeySource === 'apiKeyHelper') return { source: 'api_key_helper' };
  if (apiKeySource !== undefined) return { source: 'api_key', detail: apiKeySource };
  if (parsed['loggedIn'] !== true) {
    return parsed['loggedIn'] === false ? { source: 'none' } : { source: 'unknown' };
  }
  return { source: 'oauth_login' };
}

/** The auth-token variables are their own source: neither carries an API key. */
export function credentialEnvSource(name: string): AgentExecutorCredentialSource {
  return name === 'ANTHROPIC_API_KEY' ? 'api_key_env' : 'auth_token_env';
}
