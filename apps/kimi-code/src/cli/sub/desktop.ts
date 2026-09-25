import { spawn } from 'node:child_process';
import { constants, existsSync, accessSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import type { Command } from 'commander';

const INSTALL_GUIDE = 'https://x-t-e-r.github.io/kiki/en/getting-started/installation';

function onPath(name: string, platform: string, env: NodeJS.ProcessEnv): string | undefined {
  const extensions = platform === 'win32' ? ['', '.exe'] : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}

export function findDesktop(platform = process.platform, env = process.env): string | undefined {
  if (env['KIKI_DESKTOP_BINARY']) {
    const candidate = resolve(env['KIKI_DESKTOP_BINARY']);
    return existsSync(candidate) ? candidate : undefined;
  }
  if (platform === 'win32') {
    const candidate = env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Kiki', 'kiki-desktop.exe');
    if (candidate && existsSync(candidate)) return candidate;
  } else if (platform === 'darwin') {
    for (const candidate of ['/Applications/Kiki.app', ...(env['HOME'] ? [join(env['HOME'], 'Applications/Kiki.app')] : [])]) {
      if (existsSync(candidate)) return candidate;
    }
  } else if (platform === 'linux') {
    for (const candidate of ['/usr/bin/kiki-desktop', resolve(import.meta.dirname, '../desktop/kiki-desktop.AppImage')]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return onPath('kiki-desktop', platform, env);
}

export function registerDesktopCommand(program: Command): void {
  program.command('desktop').description('Open the installed Kiki desktop app.').action(async () => {
    const desktop = findDesktop();
    if (!desktop) {
      throw new Error(`Kiki desktop is not installed. Download the desktop bundle: ${INSTALL_GUIDE}`);
    }
    const command = process.platform === 'darwin' && desktop.endsWith('.app') ? 'open' : desktop;
    const args = command === 'open' ? ['-a', desktop] : [];
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', rejectLaunch);
      child.once('spawn', () => {
        child.unref();
        resolveLaunch();
      });
    });
  });
}
