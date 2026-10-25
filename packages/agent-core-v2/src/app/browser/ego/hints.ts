import { posix, win32 } from 'node:path';
import { join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { runEgoDetectionCommand } from './process';

import { EGO_BROWSER_EXE, EGO_LITE_DISPLAY_NAME, EGO_PUBLISHER_MARK, type EgoUninstallRecord } from './resolveCli';

export async function egoFileExists(files: IHostFileSystem, file: string): Promise<boolean> {
  try {
    const stat = await files.stat(file);
    return stat.isFile === true;
  } catch {
    return false;
  }
}

export async function egoChildNames(files: IHostFileSystem, directory: string): Promise<readonly string[]> {
  try {
    const entries = await files.readdir(directory);
    return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function egoPathDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.delimiter : posix.delimiter;
}

export async function egoPathHits(pathEnv: string | undefined, exists: (file: string) => Promise<boolean>, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (pathEnv === undefined || pathEnv.trim() === '') return [];
  const hits: string[] = [];
  for (const directory of pathEnv.split(egoPathDelimiter(platform))) {
    if (directory.trim() === '') continue;
    const candidate = join(directory, EGO_BROWSER_EXE);
    if (await exists(candidate) && !hits.includes(candidate)) hits.push(candidate);
  }
  return hits;
}

export function parseEgoUninstallExport(text: string): EgoUninstallRecord[] {
  const records: EgoUninstallRecord[] = [];
  let current: { displayName?: string; publisher?: string; installLocation?: string; displayVersion?: string } | undefined;
  const flush = (): void => {
    if (current?.displayName !== undefined && current.publisher !== undefined && current.installLocation !== undefined && current.installLocation !== '') {
      records.push({
        displayName: current.displayName,
        publisher: current.publisher,
        installLocation: current.installLocation,
        ...(current.displayVersion !== undefined && current.displayVersion !== '' ? { displayVersion: current.displayVersion } : {}),
      });
    }
    current = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      flush();
      current = {};
      continue;
    }
    const match = /^\s+(DisplayName|Publisher|InstallLocation|DisplayVersion)\s+REG_\w+\s+(.*)$/.exec(line);
    if (match === null || current === undefined) continue;
    const value = match[2]?.trim() ?? '';
    if (match[1] === 'DisplayName') current.displayName = value;
    else if (match[1] === 'Publisher') current.publisher = value;
    else if (match[1] === 'InstallLocation') current.installLocation = value;
    else current.displayVersion = value;
  }
  flush();
  return records.filter((record) => record.displayName === EGO_LITE_DISPLAY_NAME && record.publisher.includes(EGO_PUBLISHER_MARK));
}

export function expandRegistryPath(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(env, name)) return env[name] ?? whole;
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : env[key] ?? whole;
  });
}

export function parseRegistryPathValue(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/i.exec(line);
    if (match === null) continue;
    const value = match[1]?.trim() ?? '';
    return value === '' ? undefined : value;
  }
  return undefined;
}

function registryExecutable(signal?: AbortSignal): string {
  if (signal === undefined) return 'reg.exe';
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  return win32.join(win32.isAbsolute(root) ? root : 'C:\\Windows', 'System32', 'reg.exe');
}

async function readRegistryPath(processes: IHostProcessService, key: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await runEgoDetectionCommand(processes, registryExecutable(signal), ['query', key, '/v', 'Path'], signal);
    return result.code === 0 ? parseRegistryPathValue(result.stdout) : undefined;
  } catch (error) {
    if (signal !== undefined) throw error;
    return undefined;
  }
}

export async function readRegisteredEgoPath(processes: IHostProcessService, env: NodeJS.ProcessEnv, platform = process.platform, signal?: AbortSignal): Promise<string | undefined> {
  if (platform !== 'win32') return undefined;
  const results = await Promise.allSettled([
    readRegistryPath(processes, 'HKCU\\Environment', signal),
    readRegistryPath(processes, 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', signal),
  ]);
  const values = results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  const parts = values.filter((part): part is string => part !== undefined).map((part) => expandRegistryPath(part, env));
  return parts.length === 0 ? undefined : parts.join(egoPathDelimiter(platform));
}

const EGO_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const;

async function readUninstallHive(processes: IHostProcessService, key: string, signal?: AbortSignal): Promise<readonly EgoUninstallRecord[]> {
  try {
    const result = await runEgoDetectionCommand(processes, registryExecutable(signal), ['query', key, '/s'], signal);
    return result.code === 0 ? parseEgoUninstallExport(result.stdout) : [];
  } catch (error) {
    if (signal !== undefined) throw error;
    return [];
  }
}

export async function readEgoUninstallRecords(processes: IHostProcessService, platform = process.platform, signal?: AbortSignal): Promise<readonly EgoUninstallRecord[]> {
  if (platform !== 'win32') return [];
  const records: EgoUninstallRecord[] = [];
  const hives = await Promise.allSettled(EGO_UNINSTALL_KEYS.map((key) => readUninstallHive(processes, key, signal)));
  for (const hive of hives) {
    if (hive.status === 'rejected') throw hive.reason;
    for (const record of hive.value) {
      const known = records.some((item) => item.displayName === record.displayName && item.installLocation === record.installLocation && item.displayVersion === record.displayVersion);
      if (!known) records.push(record);
    }
  }
  return records;
}
