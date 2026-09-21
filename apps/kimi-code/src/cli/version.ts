/**
 * Kimi Code version helpers.
 *
 * `getVersion` reads the host CLI's `package.json#version`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadRuntimeConfigSafe, resolveConfigPath } from '@kiki/node-sdk';
import { createKimiUserAgent, KIMI_CODE_PLATFORM, type KimiHostIdentity } from '@kiki/oauth';

import {
  CLI_USER_AGENT_PRODUCT,
  KIMI_CODE_CLI_USER_AGENT_PRODUCT,
} from '#/constant/app';

import { KIMI_BUILD_INFO } from './build-info';

const MODULE_DIR = import.meta.dirname;

export function getHostPackageJsonPath(): string {
  // Walk upwards from this file's directory until a `package.json` shows up,
  // so both dev (`tsx src/main.ts` — this file in `src/cli/`, pkg 2 levels
  // up) and prod (`node dist/main.mjs` — this code bundled into `dist/`,
  // pkg 1 level up) resolve correctly.
  let dir = MODULE_DIR;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate package.json near ${MODULE_DIR}`);
}

export function getHostPackageRoot(): string {
  return dirname(getHostPackageJsonPath());
}

export function getVersion(): string {
  if (KIMI_BUILD_INFO.version !== undefined) {
    return KIMI_BUILD_INFO.version;
  }
  const pkg = JSON.parse(readFileSync(getHostPackageJsonPath(), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

export interface CliIdentityConfigLocation {
  readonly homeDir?: string;
  readonly configPath?: string;
}

export function createKimiCodeHostIdentity(
  version = getVersion(),
  config: CliIdentityConfigLocation = {},
): KimiHostIdentity {
  return {
    productName: configuredUserAgentProduct(config),
    version,
    platform: KIMI_CODE_PLATFORM,
  };
}

/** Product User-Agent for ad-hoc outbound fetches outside the provider pipeline. */
export function createKimiCodeUserAgent(
  version = getVersion(),
  config: CliIdentityConfigLocation = {},
): string {
  return createKimiUserAgent(createKimiCodeHostIdentity(version, config));
}

function configuredUserAgentProduct(config: CliIdentityConfigLocation): string {
  const rawIdentity = loadRuntimeConfigSafe(resolveConfigPath(config)).config.raw?.['identity'];
  const advertiseAsKimiCode =
    typeof rawIdentity === 'object' &&
    rawIdentity !== null &&
    !Array.isArray(rawIdentity) &&
    (rawIdentity as Record<string, unknown>)['advertise_as_kimi_code'] === true;
  return advertiseAsKimiCode
    ? KIMI_CODE_CLI_USER_AGENT_PRODUCT
    : CLI_USER_AGENT_PRODUCT;
}
