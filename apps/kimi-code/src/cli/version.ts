/**
 * Kimi Code version helpers.
 *
 * `getVersion` reads the host CLI's `package.json#version`.
 */

import { loadRuntimeConfigSafe, resolveConfigPath } from '@kiki/node-sdk';
import { createKimiUserAgent, KIMI_CODE_PLATFORM, type KimiHostIdentity } from '@kiki/oauth';

import {
  CLI_USER_AGENT_PRODUCT,
  KIMI_CODE_CLI_USER_AGENT_PRODUCT,
} from '#/constant/app';

import { getVersion } from './package-version';

export { getHostPackageJsonPath, getHostPackageRoot, getVersion } from './package-version';

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
