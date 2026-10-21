import { delimiter } from 'node:path';
import { join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

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

export async function egoPathHits(pathEnv: string | undefined, exists: (file: string) => Promise<boolean>): Promise<string[]> {
  if (pathEnv === undefined || pathEnv.trim() === '') return [];
  const hits: string[] = [];
  for (const directory of pathEnv.split(delimiter)) {
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

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function readEgoUninstallRecords(processes: IHostProcessService, platform = process.platform): Promise<readonly EgoUninstallRecord[]> {
  if (platform !== 'win32') return [];
  let child: IHostProcess | undefined;
  try {
    child = await processes.spawn('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], { shell: false, windowsHide: true });
    const [code, stdout] = await Promise.all([child.wait(), readStream(child.stdout)]);
    if (code !== 0) return [];
    return parseEgoUninstallExport(stdout);
  } catch {
    return [];
  } finally {
    await child?.dispose();
  }
}
