import { isWindowsMcpServeReady, windowsMcpInvocation } from './computer';
import type { McpServerConfig } from './config-schema';

export type McpServerConfigView =
  | (Omit<Extract<McpServerConfig, { readonly transport: 'stdio' }>, 'env'> & {
      readonly envKeys?: readonly string[];
      readonly computerServeReady?: boolean;
    })
  | (Omit<Exclude<McpServerConfig, { readonly transport: 'stdio' }>, 'headers'> & {
      readonly headerKeys?: readonly string[];
    });

/** Project a full effective config into its wire-facing view. */
export function toMcpServerConfigView(config: McpServerConfig): McpServerConfigView {
  if (config.transport === 'stdio') {
    const { env, ...safe } = config;
    const computerServeReady = windowsMcpInvocation(config) ? isWindowsMcpServeReady(config) : undefined;
    return {
      ...safe,
      envKeys: env === undefined ? undefined : Object.keys(env).toSorted(),
      computerServeReady,
    };
  }
  const { headers, ...safe } = config;
  return headers === undefined ? safe : { ...safe, headerKeys: Object.keys(headers).toSorted() };
}
