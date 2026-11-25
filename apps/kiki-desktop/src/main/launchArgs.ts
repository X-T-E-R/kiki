import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { normalize } from 'pathe';
import type { DesktopWindowMode, SpaceWindowMode } from '#/shared/types';

const PRESET_RE = /^[a-z][a-z0-9-]{0,63}$/;
const REMOTE_CONNECTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ParsedLaunchArgs {
  readonly startTrayOnly: boolean;
  readonly startAutostart: boolean;
  readonly startInBackground: boolean;
  readonly startWindowless: boolean;
  readonly home?: string;
  readonly preset?: string;
  readonly remoteConnection?: string;
  readonly positionals: readonly string[];
}

export function isValidPresetId(id: string): boolean {
  return PRESET_RE.test(id);
}

export function isValidRemoteConnectionId(id: string): boolean {
  return REMOTE_CONNECTION_ID_RE.test(id);
}

export function parseLaunchArgs(rawArgv: readonly string[]): ParsedLaunchArgs {
  const args = rawArgv.slice(1);
  const parsed = parseArgs({
    args: [...args],
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: {
      'tray-only': { type: 'boolean' },
      autostart: { type: 'boolean' },
      background: { type: 'boolean' },
      tray: { type: 'boolean' },
      minimized: { type: 'boolean' },
      home: { type: 'string', multiple: true },
      preset: { type: 'string', multiple: true },
      'remote-connection': { type: 'string', multiple: true },
    },
  });

  const requireSingleString = (
    name: 'home' | 'preset' | 'remote-connection',
    missingMessage: string,
    duplicateMessage: string,
  ): string | undefined => {
    const matching = parsed.tokens.filter(
      (token): token is Extract<(typeof parsed.tokens)[number], { kind: 'option' }> =>
        token.kind === 'option' && token.name === name,
    );
    if (matching.length === 0) return undefined;
    if (matching.length > 1) throw new Error(duplicateMessage);
    const value = matching[0]?.value;
    if (typeof value !== 'string' || value.trim() === '') throw new Error(missingMessage);
    return value;
  };

  const home = requireSingleString(
    'home',
    '--home requires a directory path',
    'Only one --home argument may be provided',
  );
  const preset = requireSingleString(
    'preset',
    '--preset requires a mode id',
    '--preset requires one valid mode id',
  );
  if (preset !== undefined && !isValidPresetId(preset)) {
    throw new Error('--preset requires one valid mode id');
  }

  const remoteConnection = requireSingleString(
    'remote-connection',
    '--remote-connection requires one connection id',
    'Only one remote connection may be selected',
  );
  if (remoteConnection !== undefined && !isValidRemoteConnectionId(remoteConnection)) {
    throw new Error('Invalid remote connection id');
  }

  const startTrayOnly = parsed.values['tray-only'] === true;
  const startAutostart = parsed.values.autostart === true;
  const startInBackground =
    startTrayOnly ||
    startAutostart ||
    parsed.values.background === true ||
    parsed.values.tray === true ||
    parsed.values.minimized === true;

  return {
    startTrayOnly,
    startAutostart,
    startInBackground,
    startWindowless: startTrayOnly || startAutostart,
    home,
    preset,
    remoteConnection,
    positionals: parsed.positionals,
  };
}

function stableHashHex(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function canonicalHomeKey(homePath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = normalize(homePath).replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function resolveWindowModeDescriptor(
  homePath: string,
  presetId = 'kiki',
  platform: NodeJS.Platform = process.platform,
): DesktopWindowMode {
  const key = canonicalHomeKey(homePath, platform);
  return {
    presetId,
    windowId: `w-${stableHashHex(key)}-${presetId}`,
  };
}

export interface InstanceIdentityInput {
  readonly baseAppId: string;
  readonly startupHome: string;
  readonly mainHome: string;
  readonly windowMode: SpaceWindowMode;
  readonly spaceHomeId?: string;
  readonly preset?: string;
  readonly remoteConnection?: string;
  readonly platform?: NodeJS.Platform;
}

export interface ResolvedInstanceIdentity {
  readonly appId: string;
  readonly userDataSuffix: string;
  readonly effectiveWindowMode: SpaceWindowMode;
  readonly descriptor: DesktopWindowMode;
}

export function resolveInstanceIdentity(input: InstanceIdentityInput): ResolvedInstanceIdentity {
  const platform = input.platform ?? process.platform;
  const startupKey = canonicalHomeKey(input.startupHome, platform);
  const mainKey = canonicalHomeKey(input.mainHome, platform);
  const isChildHome = startupKey !== mainKey;
  const effectiveWindowMode: SpaceWindowMode =
    input.remoteConnection !== undefined || input.preset !== undefined || isChildHome
      ? 'windows'
      : input.windowMode;

  let appId = input.baseAppId;
  const segments: string[] = [];

  if (effectiveWindowMode === 'windows' && isChildHome) {
    const spaceTag = input.spaceHomeId ?? stableHashHex(startupKey);
    appId = `${appId}.space.${spaceTag}`;
    segments.push(`space-${spaceTag}`);
  }

  if (input.remoteConnection !== undefined) {
    const compactId = input.remoteConnection.replaceAll('-', '');
    const homeHash = stableHashHex(startupKey);
    appId = `${appId}.remote.${homeHash}.${compactId}`;
    segments.push(`remote-${homeHash}-${compactId}`);
  }

  const descriptor = resolveWindowModeDescriptor(input.startupHome, input.preset ?? 'kiki', platform);
  if (input.preset !== undefined) {
    appId = `${appId}.mode.${descriptor.windowId}`;
    segments.push(`mode-${descriptor.windowId}`);
  }

  return {
    appId,
    userDataSuffix: segments.length > 0 ? segments.join('-') : 'default',
    effectiveWindowMode,
    descriptor,
  };
}
