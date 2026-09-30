import { join } from 'pathe';
import { gte, valid } from 'semver';

import { Error2, ErrorCodes } from '#/errors';

export const ANTIGRAVITY_VERSION = '1.2.1';

export interface AntigravityRelease {
  readonly version: string;
  readonly platform: string;
  readonly url: string;
  readonly entry: string;
  readonly requiredSibling: string;
  readonly args: readonly string[];
}

export function antigravityRelease(version: string, platform: NodeJS.Platform, arch: string): AntigravityRelease {
  const normalized = valid(version.trim().replace(/^v/, ''));
  if (normalized === null || !normalized.startsWith('1.')) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Antigravity ACP version must be an explicit 1.x semantic version');
  const system = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
  const architecture = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x86_64' : undefined;
  if (system === undefined || architecture === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Antigravity ACP has no release for this platform');
  const target = `${platform === 'darwin' ? 'darwin' : system}-${architecture}`;
  const archive = gte(normalized, '1.2.0') ? `agy-acp-server-${normalized}-${target}.zip` : `agy-acp-server-agy_acp_server_${normalized}-${target}.zip`;
  return {
    version: normalized,
    platform: `${platform}-${arch}`,
    url: `https://dl.google.com/agy-extensions/releases/${system}/${archive}`,
    entry: platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par',
    requiredSibling: platform === 'win32' ? 'localharness_external.exe' : 'localharness_external',
    args: platform === 'linux' ? ['--uid='] : [],
  };
}

export function antigravityCacheRoot(homeDir: string): string {
  return join(homeDir, 'tools', 'antigravity-acp');
}
