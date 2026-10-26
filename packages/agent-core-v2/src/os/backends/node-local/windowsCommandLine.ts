import type { SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';

import { HostProcessError, HostProcessErrorCode } from '#/os/interface/hostProcess';

const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).toSorted().find((key) => key.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key];
  return value === '' ? undefined : value;
}

function resolveExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const extensions = (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => extension.trim()).filter(Boolean);
  const explicit = /[\\/:]/.test(command);
  const extended = extensions.map((extension) => command + extension);
  const names = explicit || win32.extname(command) ? [command, ...extended] : extended;
  const directories = explicit ? [''] : (environmentValue(env, 'PATH') ?? '').split(';').filter(Boolean);
  for (const directory of directories) {
    const root = directory.replace(/^"(.*)"$/, '$1');
    for (const name of names) {
      const candidate = win32.resolve(cwd, root, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { }
    }
  }
  throw new HostProcessError(HostProcessErrorCode.SpawnFailed, `Failed to spawn "${command}": command not found (ENOENT).`, {
    details: { command, cwd, errno: 'ENOENT', phase: 'resolve' },
    cause: Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', syscall: `spawn ${command}`, path: command }),
  });
}

export function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function escapeCmdArgument(value: string): string {
  return quoteWindowsArgument(value).replace(CMD_META_CHARACTERS, '^$1').replace(CMD_META_CHARACTERS, '^$1');
}

/**
 * Prepares native Windows launches and escapes arguments forwarded by batch launchers.
 *
 * @license
 * Cmd metacharacter escaping adapted from cross-spawn 7.0.6 (MIT).
 * Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
export function prepareWindowsSpawn(command: string, args: readonly string[], options: SpawnOptions): { command: string; args: readonly string[]; options: SpawnOptions } {
  const env = options.env ?? process.env;
  const cwd = win32.resolve(options.cwd?.toString() ?? process.cwd());
  if (options.shell) {
    const shell = resolveExecutable(typeof options.shell === 'string' ? options.shell : environmentValue(env, 'ComSpec') ?? 'cmd.exe', cwd, env);
    const text = [command, ...args].join(' ');
    const cmd = /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell);
    return { command: shell, args: cmd ? ['/d', '/s', '/c', `"${text}"`] : ['-c', text], options: { ...options, shell: false, windowsVerbatimArguments: cmd } };
  }
  const executable = resolveExecutable(command, cwd, env);
  if (!/\.(?:cmd|bat)$/i.test(executable)) return { command: executable, args, options };
  const argumentIndex = args.findIndex((arg) => /[\0\r\n]/.test(arg));
  if (argumentIndex !== -1) {
    throw new HostProcessError(HostProcessErrorCode.SpawnFailed, 'Batch launcher arguments cannot contain NUL or newlines. Use a direct executable instead.', {
      details: { command, cwd, errno: 'EINVAL', phase: 'arguments', argumentIndex },
    });
  }
  const shell = resolveExecutable(environmentValue(env, 'ComSpec') ?? 'cmd.exe', cwd, env);
  const text = [executable.replace(CMD_META_CHARACTERS, '^$1'), ...args.map(escapeCmdArgument)].join(' ');
  return { command: shell, args: ['/d', '/v:off', '/s', '/c', `"${text}"`], options: { ...options, shell: false, windowsVerbatimArguments: true } };
}
