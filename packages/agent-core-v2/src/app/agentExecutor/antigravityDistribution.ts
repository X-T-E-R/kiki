import { join } from 'pathe';
import { gte, valid } from 'semver';

import { Error2, ErrorCodes } from '#/errors';

export const ANTIGRAVITY_CLI_MANIFEST_BASE =
  'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
export const ANTIGRAVITY_STORAGE_BASE =
  'https://storage.googleapis.com/antigravity-public/antigravity-cli';
export const ANTIGRAVITY_VERSION = '1.4.5';
export const ANTIGRAVITY_OFFICIAL_FALLBACK_VERSION = '1.5.4';
export const ANTIGRAVITY_CLI_MIN_VERSION = '1.5.0';
export const ANTIGRAVITY_CLI_ACP_ARGS = ['acp'] as const;

export type AntigravityReleaseLayout = 'official-cli' | 'legacy-pair';

export interface AntigravityRelease {
  readonly version: string;
  readonly platform: string;
  readonly url: string;
  readonly entry: string;
  readonly requiredSibling: string;
  readonly layout: AntigravityReleaseLayout;
  readonly format?: 'executable' | 'tar.gz' | 'zip';
  readonly args: readonly string[];
  readonly sha256?: string;
  readonly sha512?: string;
  readonly archiveBytes?: number;
  readonly executableBytes?: number;
  readonly harnessBytes?: number;
}

interface AntigravityLegacyReleaseAsset {
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executableBytes: number;
  readonly harnessBytes: number;
}

const ANTIGRAVITY_145_ASSETS: Readonly<Record<string, AntigravityLegacyReleaseAsset>> = {
  'darwin-arm64': { sha256: '886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f', archiveBytes: 97_923_855, executableBytes: 178_915_920, harnessBytes: 122_957_936 },
  'darwin-x64': { sha256: 'b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a', archiveBytes: 103_577_295, executableBytes: 183_127_600, harnessBytes: 127_612_208 },
  'linux-x64': { sha256: '923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b', archiveBytes: 321_783_181, executableBytes: 826_226_766, harnessBytes: 133_926_136 },
  'linux-arm64': { sha256: '7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056', archiveBytes: 307_829_008, executableBytes: 831_194_025, harnessBytes: 127_512_832 },
  'win32-x64': { sha256: 'd24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50', archiveBytes: 100_423_655, executableBytes: 55_839_864, harnessBytes: 147_843_736 },
  'win32-arm64': { sha256: 'ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c', archiveBytes: 102_703_121, executableBytes: 62_293_488, harnessBytes: 139_322_008 },
};

export function antigravityCliTarget(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): string | undefined {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    return undefined;
  }
  const os = platform === 'win32' ? 'windows' : platform;
  return `${os}_${arch === 'x64' ? 'amd64' : arch}${platform === 'linux' && musl ? '_musl' : ''}`;
}

export function parseAntigravityCliRelease(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityRelease | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const version = typeof record['version'] === 'string' ? record['version'].trim() : '';
  const url = typeof record['url'] === 'string' ? record['url'].trim() : '';
  const sha512 = typeof record['sha512'] === 'string' ? record['sha512'].trim().toLowerCase() : '';
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !/^[a-f0-9]{128}$/u.test(sha512)) return undefined;
  if (antigravityCliTarget(platform, arch, musl) === undefined) return undefined;
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
  const cpu = arch === 'x64' ? 'x64' : 'arm64';
  const suffix = platform === 'linux' && musl ? '_musl' : '';
  const extension = platform === 'win32' ? 'exe' : 'tar.gz';
  const folder = `${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'arm' : 'x64'}${suffix ? '-musl' : ''}`;
  const prefix = `${ANTIGRAVITY_STORAGE_BASE}/${version}-`;
  const rest = url.startsWith(prefix) ? url.slice(prefix.length) : '';
  if (!/^\d+\//u.test(rest) || rest.replace(/^\d+\//u, '') !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`) {
    return undefined;
  }
  return {
    version,
    platform: `${platform}-${arch}${suffix}`,
    url,
    entry: platform === 'win32' ? 'agy.exe' : 'antigravity',
    requiredSibling: '',
    layout: 'official-cli',
    format: platform === 'win32' ? 'executable' : 'tar.gz',
    args: [...ANTIGRAVITY_CLI_ACP_ARGS],
    sha512,
  };
}

export function antigravityOfficialFallbackRelease(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityRelease {
  const target = antigravityCliTarget(platform, arch, musl);
  if (target === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Antigravity ACP has no release for this platform');
  }
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
  const cpu = arch === 'x64' ? 'x64' : 'arm64';
  const suffix = platform === 'linux' && musl ? '_musl' : '';
  const extension = platform === 'win32' ? 'exe' : 'tar.gz';
  const folder = `${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'arm' : 'x64'}${suffix ? '-musl' : ''}`;
  return {
    version: ANTIGRAVITY_OFFICIAL_FALLBACK_VERSION,
    platform: `${platform}-${arch}${suffix}`,
    url: `${ANTIGRAVITY_STORAGE_BASE}/${ANTIGRAVITY_OFFICIAL_FALLBACK_VERSION}-0/${folder}/cli_${os}_${cpu}${suffix}.${extension}`,
    entry: platform === 'win32' ? 'agy.exe' : 'antigravity',
    requiredSibling: '',
    layout: 'official-cli',
    format: platform === 'win32' ? 'executable' : 'tar.gz',
    args: [...ANTIGRAVITY_CLI_ACP_ARGS],
  };
}

export async function fetchAntigravityCliManifest(
  platform: NodeJS.Platform,
  arch: string,
  options: { readonly musl?: boolean; readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<AntigravityRelease | undefined> {
  const musl = options.musl ?? false;
  const target = antigravityCliTarget(platform, arch, musl);
  if (target === undefined) return undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(10_000);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  try {
    const response = await fetchImpl(`${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`, {
      signal,
      redirect: 'follow',
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    return parseAntigravityCliRelease(payload, platform, arch, musl);
  } catch {
    return undefined;
  }
}

export function antigravityRelease(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityRelease {
  const normalized = valid(version.trim().replace(/^v/, ''));
  if (normalized === null || !normalized.startsWith('1.')) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'Antigravity ACP version must be an explicit 1.x semantic version');
  }
  if (gte(normalized, ANTIGRAVITY_CLI_MIN_VERSION)) {
    const fallback = antigravityOfficialFallbackRelease(platform, arch, musl);
    const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
    const cpu = arch === 'x64' ? 'x64' : 'arm64';
    const suffix = platform === 'linux' && musl ? '_musl' : '';
    const extension = platform === 'win32' ? 'exe' : 'tar.gz';
    const folder = `${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'arm' : 'x64'}${suffix ? '-musl' : ''}`;
    return {
      ...fallback,
      version: normalized,
      url: `${ANTIGRAVITY_STORAGE_BASE}/${normalized}-0/${folder}/cli_${os}_${cpu}${suffix}.${extension}`,
    };
  }
  const system = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
  const architecture = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x86_64' : undefined;
  if (system === undefined || architecture === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Antigravity ACP has no release for this platform');
  }
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
    layout: 'legacy-pair',
    format: 'zip',
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

export function antigravityOfficialVersionsRoot(homeDir: string): string {
  return join(antigravityCacheRoot(homeDir), 'versions');
}
