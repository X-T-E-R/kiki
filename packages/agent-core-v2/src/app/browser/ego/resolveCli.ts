import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { isAbsolute, join } from 'pathe';

import { sliceUtf16 } from '#/_base/text/utf16';

export const EGO_LITE_DOWNLOAD_URL = 'https://lite.ego.app/download?auto=1';
export const EGO_LITE_CONNECTION_ID = 'ego-lite';
export const EGO_BROWSER_EXE = 'ego-browser.exe';
export const EGO_LITE_DISPLAY_NAME = 'ego (lite)';
export const EGO_PUBLISHER_MARK = 'Citro Labs';
export const EGO_ONBOARDING_SENTENCE = 'Please complete the onboarding process first';
export const EGO_READY_MARKER = 'kiki-ego-ready';
export const EGO_SPACE_FILE = 'browser-ego-spaces.json';
export const EGO_NAME_IN_USE = 'EGO_TASK_SPACE_NAME_IN_USE';
export const EGO_USER_IN_CONTROL = 'EGO_TASK_SPACE_USER_IN_CONTROL';
export const EGO_SDK_ENV = 'KIKI_EGO_SDK_PATH';

export interface EgoUninstallRecord {
  readonly displayName: string;
  readonly publisher: string;
  readonly installLocation: string;
  readonly displayVersion?: string;
}

export interface EgoCliResolveInput {
  readonly cliPath?: string;
  readonly exists: (file: string) => boolean;
  readonly children: (directory: string) => readonly string[];
  readonly records: readonly EgoUninstallRecord[];
  readonly pathHits: readonly string[];
}

export type EgoCliResolution =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'choose'; readonly paths: readonly string[] }
  | { readonly kind: 'missing' };

export function egoSpaceName(sessionId: string, agentId: string): string {
  const digest = createHash('sha256').update(`${sessionId}\0${agentId}`).digest('hex');
  return `kiki-${digest}`.slice(0, 80);
}

export function classifyEgoCheck(output: string): 'ready' | 'onboarding' | 'not_ready' {
  if (output.includes(EGO_ONBOARDING_SENTENCE)) return 'onboarding';
  if (output.includes(EGO_READY_MARKER)) return 'ready';
  return 'not_ready';
}

export function extractEgoDiagnostic(output: string): string | undefined {
  const lines = stripVTControlCharacters(output)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .split(/[\r\n]+/)
    .map((line) => line.replaceAll(EGO_READY_MARKER, '').trim())
    .filter((line) => line !== '' && !/ego-scripts(?:[\\/]|%2f|%5c)|^at\s|^Node\.js v\d/i.test(line));
  const diagnostic = [...new Set(lines)].join(' ').replace(/\s+/g, ' ').trim();
  if (diagnostic === '') return undefined;
  return diagnostic.length <= 400 ? diagnostic : `${sliceUtf16(diagnostic, 0, 399).trimEnd()}…`;
}

export function egoNotReadyMessage(output: string): string {
  const diagnostic = extractEgoDiagnostic(output);
  return diagnostic === undefined ? 'Ego Lite is not ready' : `Ego Lite is not ready: ${diagnostic}`;
}

function matchingRecords(records: readonly EgoUninstallRecord[]): EgoUninstallRecord[] {
  return records.filter((record) => record.displayName === EGO_LITE_DISPLAY_NAME && record.publisher.includes(EGO_PUBLISHER_MARK));
}

function pathMatchesVersion(file: string, version: string): boolean {
  return file.split(/[\\/]/).includes(version);
}

export function resolveEgoCli(input: EgoCliResolveInput): EgoCliResolution {
  const saved = input.cliPath?.trim();
  if (saved !== undefined && saved !== '' && isAbsolute(saved) && input.exists(saved)) return { kind: 'found', path: saved };
  const paths: string[] = [];
  const versions: string[] = [];
  const add = (file: string | undefined): void => {
    if (file === undefined || file === '' || !input.exists(file) || paths.includes(file)) return;
    paths.push(file);
  };
  for (const record of matchingRecords(input.records)) {
    if (record.displayVersion !== undefined && record.displayVersion !== '') versions.push(record.displayVersion);
    const versioned = record.displayVersion === undefined || record.displayVersion === ''
      ? undefined
      : join(record.installLocation, record.displayVersion, EGO_BROWSER_EXE);
    if (versioned !== undefined && input.exists(versioned)) {
      add(versioned);
      continue;
    }
    const kids = input.children(record.installLocation).filter((child) => input.exists(join(record.installLocation, child, EGO_BROWSER_EXE)));
    for (const child of kids) add(join(record.installLocation, child, EGO_BROWSER_EXE));
  }
  for (const hit of input.pathHits) add(hit);
  if (paths.length === 0) return { kind: 'missing' };
  if (paths.length === 1) return { kind: 'found', path: paths[0]! };
  const versionHits = paths.filter((file) => versions.some((version) => pathMatchesVersion(file, version)));
  if (versionHits.length === 1) return { kind: 'found', path: versionHits[0]! };
  return { kind: 'choose', paths: [...paths].sort() };
}
