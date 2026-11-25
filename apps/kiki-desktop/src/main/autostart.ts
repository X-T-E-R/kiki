import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { atomicWriteSync } from '@kiki/kaos/atomic-fs';
import { basename, dirname, isAbsolute, join } from 'pathe';
import { stripWindowsVerbatimPrefix } from '#/main/releaseRedirect';
import type { DesktopAutostartStatus } from '#/shared/types';

export const AUTOSTART_FLAG = '--autostart';
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_RUN_VALUE_NAME = 'Kiki';
const STALE_ELECTRON_RUN_VALUE_NAMES = ['electron.app.Kiki', 'electron.app.kiki-desktop'] as const;
const LINUX_DESKTOP_ENTRY_NAME = 'ai.easyagent.kiki.desktop';

export interface WindowsRegistryRunner {
  queryValue(key: string, valueName: string): string | null;
  setValue(key: string, valueName: string, data: string): void;
  deleteValue(key: string, valueName: string): void;
}

export function createDefaultWindowsRegistryRunner(): WindowsRegistryRunner {
  const regExe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe');
  return {
    queryValue(key: string, valueName: string): string | null {
      const res = spawnSync(regExe, ['query', key, '/v', valueName], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (res.status !== 0) return null;
      for (const line of res.stdout.split(/\r?\n/)) {
        const match = new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+(.*)$`, 'i').exec(line);
        if (match !== null) {
          const val = match[1]?.trim() ?? '';
          return val === '' ? null : val;
        }
      }
      return null;
    },
    setValue(key: string, valueName: string, data: string): void {
      const res = spawnSync(regExe, ['add', key, '/v', valueName, '/t', 'REG_SZ', '/d', data, '/f'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (res.status !== 0) {
        throw new Error(`Cannot save Windows autostart entry: ${(res.stderr || res.stdout).trim()}`);
      }
    },
    deleteValue(key: string, valueName: string): void {
      const res = spawnSync(regExe, ['delete', key, '/v', valueName, '/f'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (res.status !== 0) {
        const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
        if (!/unable to find|找不到|cannot find/i.test(output)) {
          const check = this.queryValue(key, valueName);
          if (check !== null) {
            throw new Error(`Cannot remove Windows autostart entry: ${output.trim()}`);
          }
        }
      }
    },
  };
}

/**
 * Prefer `<RuntimeRoot>/active/<exeName>` when `resolvedExe` lives under
 * `<RuntimeRoot>/releases/<id>/` and `active/<exeName>` is a real non-symlink file.
 */
export function resolveAutostartExecutablePath(
  resolvedExe: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = stripWindowsVerbatimPrefix(resolvedExe);
  const releaseDir = dirname(normalized);
  const releasesDir = dirname(releaseDir);
  if (basename(releasesDir).toLowerCase() === 'releases') {
    const runtimeRoot = dirname(releasesDir);
    const exeName = basename(normalized);
    const activeCandidate = join(runtimeRoot, 'active', exeName);
    try {
      const info = lstatSync(activeCandidate);
      if (info.isFile() && info.size > 0 && !info.isSymbolicLink()) {
        return platform === 'win32' ? activeCandidate.replaceAll('/', '\\') : activeCandidate;
      }
    } catch {
      // Fall back to resolvedExe when active/ is absent.
    }
  }
  return platform === 'win32' ? normalized.replaceAll('/', '\\') : normalized;
}

export function formatAutostartCommand(
  exePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(exePath);
  const abs = platform === 'win32' ? isWinAbs : isAbsolute(exePath);
  if (!abs || exePath.includes('"') || /[\u0000-\u001F\u007F]/.test(exePath)) {
    throw new Error('Kiki executable path cannot be registered for autostart');
  }
  if (platform === 'linux') {
    const escaped = exePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    return `"${escaped}" ${AUTOSTART_FLAG}`;
  }
  return `"${exePath}" ${AUTOSTART_FLAG}`;
}

export function resolveLinuxAutostartDesktopPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgConfig = env['XDG_CONFIG_HOME']?.trim();
  const base = xdgConfig !== undefined && xdgConfig !== '' ? xdgConfig : join(homedir(), '.config');
  return join(base, 'autostart', LINUX_DESKTOP_ENTRY_NAME);
}

export function readLinuxAutostartStatus(desktopEntryPath: string): DesktopAutostartStatus {
  if (!existsSync(desktopEntryPath)) {
    return { enabled: false, supported: true, command: null };
  }
  const content = readFileSync(desktopEntryPath, 'utf8');
  const execLine = content
    .split(/\r?\n/)
    .find((line) => line.startsWith('Exec='))
    ?.slice('Exec='.length)
    .trim();
  return {
    enabled: Boolean(execLine),
    supported: true,
    command: execLine ?? null,
  };
}

export function writeLinuxAutostartStatus(
  desktopEntryPath: string,
  enabled: boolean,
  exePath: string,
): DesktopAutostartStatus {
  if (!enabled) {
    rmSync(desktopEntryPath, { force: true });
    return { enabled: false, supported: true, command: null };
  }
  const command = formatAutostartCommand(exePath, 'linux');
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Kiki',
    'Comment=Start Kiki in the system tray',
    `Exec=${command}`,
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
  mkdirSync(dirname(desktopEntryPath), { recursive: true });
  atomicWriteSync(desktopEntryPath, entry, 0o644);
  return { enabled: true, supported: true, command };
}

export function cleanupStaleWindowsElectronRunEntries(registry: WindowsRegistryRunner): void {
  for (const staleName of STALE_ELECTRON_RUN_VALUE_NAMES) {
    try {
      registry.deleteValue(WINDOWS_RUN_KEY, staleName);
    } catch {
      continue;
    }
  }
}
