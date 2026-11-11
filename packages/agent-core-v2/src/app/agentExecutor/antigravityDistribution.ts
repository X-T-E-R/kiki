import { join } from 'pathe';
import { gte, valid } from 'semver';

import { Error2, ErrorCodes } from '#/errors';

export const ANTIGRAVITY_VERSION = '1.4.5';
export const ANTIGRAVITY_CLI_MIN_VERSION = '1.5.1';
export const ANTIGRAVITY_CLI_ACP_ARGS = ['acp', '--stdio', '--process-per-session'] as const;

export interface AntigravityRelease {
  readonly version: string;
  readonly platform: string;
  readonly url: string;
  readonly entry: string;
  readonly requiredSibling: string;
  readonly args: readonly string[];
  readonly sha256?: string;
  readonly archiveBytes?: number;
  readonly executableBytes?: number;
  readonly harnessBytes?: number;
}

interface AntigravityReleaseAsset {
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executableBytes: number;
  readonly harnessBytes: number;
}

const ANTIGRAVITY_145_ASSETS: Readonly<Record<string, AntigravityReleaseAsset>> = {
  'darwin-arm64': { sha256: '886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f', archiveBytes: 97_923_855, executableBytes: 178_915_920, harnessBytes: 122_957_936 },
  'darwin-x64': { sha256: 'b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a', archiveBytes: 103_577_295, executableBytes: 183_127_600, harnessBytes: 127_612_208 },
  'linux-x64': { sha256: '923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b', archiveBytes: 321_783_181, executableBytes: 826_226_766, harnessBytes: 133_926_136 },
  'linux-arm64': { sha256: '7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056', archiveBytes: 307_829_008, executableBytes: 831_194_025, harnessBytes: 127_512_832 },
  'win32-x64': { sha256: 'd24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50', archiveBytes: 100_423_655, executableBytes: 55_839_864, harnessBytes: 147_843_736 },
  'win32-arm64': { sha256: 'ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c', archiveBytes: 102_703_121, executableBytes: 62_293_488, harnessBytes: 139_322_008 },
};

export function antigravityRelease(version: string, platform: NodeJS.Platform, arch: string): AntigravityRelease {
  const normalized = valid(version.trim().replace(/^v/, ''));
  if (normalized === null || !normalized.startsWith('1.')) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Antigravity ACP version must be an explicit 1.x semantic version');
  const system = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
  const architecture = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x86_64' : undefined;
  if (system === undefined || architecture === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Antigravity ACP has no release for this platform');
  const target = `${platform === 'darwin' ? 'darwin' : system}-${architecture}`;
  const archive = gte(normalized, '1.2.0') ? `agy-acp-server-${normalized}-${target}.zip` : `agy-acp-server-agy_acp_server_${normalized}-${target}.zip`;
  const platformKey = `${platform}-${arch}`;
  const verified = normalized === ANTIGRAVITY_VERSION ? ANTIGRAVITY_145_ASSETS[platformKey] : undefined;
  return {
    version: normalized,
    platform: platformKey,
    url: `https://dl.google.com/agy-extensions/releases/${system}/${archive}`,
    entry: platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par',
    requiredSibling: platform === 'win32' ? 'localharness_external.exe' : 'localharness_external',
    args: platform === 'linux' ? ['--uid='] : [],
    sha256: verified?.sha256,
    archiveBytes: verified?.archiveBytes,
    executableBytes: verified?.executableBytes,
    harnessBytes: verified?.harnessBytes,
  };
}

export function antigravityCacheRoot(homeDir: string): string {
  return join(homeDir, 'tools', 'antigravity-acp');
}
