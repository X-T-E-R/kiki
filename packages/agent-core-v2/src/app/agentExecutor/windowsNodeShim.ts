import { win32 } from 'node:path';

import type { HostProcessServiceLike } from '@kiki/acp-client';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { Error2, ErrorCodes } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { locateCommand } from './binaryDiscovery';

export async function resolveWindowsNodeShim(
  command: string,
  args: readonly string[],
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<{ readonly command: string; readonly args: readonly string[] }> {
  if (bootstrap.platform !== 'win32') return { command, args };
  const located = await locateCommand(command, fs, bootstrap) ?? command;
  if (!/\.(?:cmd|bat)$/i.test(located)) return { command: located, args };
  let shim: string;
  try {
    shim = await fs.readText(located);
  } catch {
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Cannot read Windows executable shim "${located}"`);
  }
  const direct = shim.match(/(?:%~dp0|%dp0%)\\node_modules\\([^\r\n"%]+\.[cm]?js)"\s+%\*/i)?.[1];
  const npmCli = /SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli\.js"/i.test(shim) &&
    /"%NODE_EXE%"\s+"%NPM_CLI_JS%"\s+%\*/i.test(shim)
    ? 'npm\\bin\\npm-cli.js' : undefined;
  const script = direct ?? npmCli;
  if (shim.length > 16_384 || script === undefined || script.split('\\').includes('..')) {
    throw new Error2(ErrorCodes.CONFIG_INVALID,
      `Windows shim "${located}" is not a supported Node launcher; configure a direct executable or node script`);
  }
  const node = await locateCommand('node', fs, bootstrap);
  if (node === undefined || !/\.exe$/i.test(node)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Node executable is required to launch a Windows npm shim directly');
  }
  return {
    command: node,
    args: [win32.join(win32.dirname(located), 'node_modules', script), ...args],
  };
}

export function wrapWindowsNodeShims<T extends HostProcessServiceLike>(
  processService: T,
  fs: IHostFileSystem | undefined,
  bootstrap: () => IBootstrapService,
): T {
  return {
    ...processService,
    spawn: async (command: string, args: readonly string[] = [], options?: Parameters<T['spawn']>[2]) => {
      const host = bootstrap();
      if (host.platform === 'win32' && fs === undefined) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'Windows executor runtime has no filesystem for shim resolution');
      }
      const launch = fs === undefined ? { command, args }
        : await resolveWindowsNodeShim(command, args, fs, host);
      return processService.spawn(launch.command, launch.args, options);
    },
  } as T;
}
