/**
 * `kimi acp` sub-command routing.
 *
 * The command is served entirely by the agent-core-v2 ACP server; the SDK
 * harness adapter that used to back a legacy route is gone with the v1 engine.
 */

import type { Command } from 'commander';

import { registerNativeAcpCommand } from './acp-native';

export function registerAcpCommand(parent: Command): void {
  registerNativeAcpCommand(parent);
}
