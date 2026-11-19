import {
  TomlFormat,
  parseDocument,
  patch as patchToml,
  type TomlDocument,
} from '@decimalturn/toml-patch';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { deepEqual, isPlainObject, stripTomlBom } from './configPure';

type TomlCstBlock = TomlDocument['cst'][number];
type TomlCstTable = Extract<TomlCstBlock, { readonly type: 'Table' }>;
type TomlCstKeyValue = Extract<TomlCstTable['items'][number], { readonly type: 'KeyValue' }>;

export interface DomainUpdate {
  readonly snakeKey: string;
  readonly previousValue: unknown;
  readonly nextValue: unknown;
}

interface DeferredSectionBlock {
  readonly path: readonly string[];
  readonly value: unknown;
}

function isObjectArray(value: unknown): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

function buildPatchFormat(originalText: string): TomlFormat {
  const format = TomlFormat.autoDetectFormat(originalText);
  format.inlineTableStart = Number.MAX_SAFE_INTEGER;
  format.updateOrder = false;
  return format;
}

function collectExplicitTablePaths(cst: readonly TomlCstBlock[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const block of cst) {
    if (block.type === 'Table') {
      paths.add(JSON.stringify(block.key.item.value));
    }
  }
  return paths;
}

function collectInlineTablePaths(cst: readonly TomlCstBlock[]): ReadonlySet<string> {
  const paths = new Set<string>();
  const visitKeyValue = (prefix: readonly string[], item: TomlCstKeyValue): void => {
    const fullPath = [...prefix, ...item.key.value];
    if (item.value.type === 'InlineTable') {
      paths.add(JSON.stringify(fullPath));
    }
  };
  for (const block of cst) {
    if (block.type === 'KeyValue') {
      visitKeyValue([], block);
    } else if (block.type === 'Table') {
      const tablePrefix = block.key.item.value;
      for (const item of block.items) {
        if (item.type === 'KeyValue') {
          visitKeyValue(tablePrefix, item);
        }
      }
    }
  }
  return paths;
}

function hasNestedObjectOrObjectArray(value: Record<string, unknown>): boolean {
  return Object.values(value).some((entry) => isPlainObject(entry) || isObjectArray(entry));
}

function splitNewSectionBlocks(
  path: readonly string[],
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  explicitTablePaths: ReadonlySet<string>,
  inlineTablePaths: ReadonlySet<string>,
  deferred: DeferredSectionBlock[],
): Record<string, unknown> | undefined {
  const serializedPath = JSON.stringify(path);
  if (inlineTablePaths.has(serializedPath) && hasNestedObjectOrObjectArray(next)) {
    deferred.push({ path, value: next });
    return undefined;
  }
  const out: Record<string, unknown> = {};
  const parentExplicit = explicitTablePaths.has(serializedPath);
  for (const [key, nextVal] of Object.entries(next)) {
    const prevVal = previous[key];
    const childPath = [...path, key];
    if (prevVal === undefined) {
      if (isObjectArray(nextVal)) {
        deferred.push({ path: childPath, value: nextVal });
        continue;
      }
      if (isPlainObject(nextVal) && !parentExplicit) {
        deferred.push({ path: childPath, value: nextVal });
        continue;
      }
      out[key] = nextVal;
      continue;
    }
    if (isPlainObject(prevVal) && isPlainObject(nextVal)) {
      const sub = splitNewSectionBlocks(
        childPath,
        prevVal,
        nextVal,
        explicitTablePaths,
        inlineTablePaths,
        deferred,
      );
      if (sub !== undefined) out[key] = sub;
      continue;
    }
    if (isObjectArray(nextVal) && !isObjectArray(prevVal)) {
      deferred.push({ path: childPath, value: nextVal });
      continue;
    }
    out[key] = nextVal;
  }
  if (Object.keys(out).length === 0 && Object.keys(next).length > 0 && !parentExplicit) {
    return undefined;
  }
  return out;
}

function serializeSectionBlock(path: readonly string[], value: unknown, eol: string): string {
  let nested: unknown = value;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    nested = { [path[i]!]: nested };
  }
  const rendered = stringifyToml(nested as Record<string, unknown>).replaceAll('\n', eol);
  return rendered.endsWith(eol) ? rendered : `${rendered}${eol}`;
}

function verifyPlannedText(text: string, expected: Record<string, unknown>): boolean {
  if (text.trim().length === 0) return Object.keys(expected).length === 0;
  try {
    return deepEqual(parseToml(stripTomlBom(text)), expected);
  } catch {
    return false;
  }
}

function preserveLeadingBom(originalText: string, text: string): string {
  return originalText.startsWith('\uFEFF') && !text.startsWith('\uFEFF') ? `\uFEFF${text}` : text;
}

export function planConfigWriteback(
  originalText: string,
  updates: readonly DomainUpdate[],
  expected: Record<string, unknown>,
): string | undefined {
  let current: unknown;
  let doc;
  try {
    current = parseToml(stripTomlBom(originalText));
    doc = parseDocument(originalText);
  } catch {
    return undefined;
  }
  if (!isPlainObject(current)) return undefined;

  const explicitTablePaths = collectExplicitTablePaths(doc.cst);
  const inlineTablePaths = collectInlineTablePaths(doc.cst);
  const deferred: DeferredSectionBlock[] = [];
  let changed = false;
  const patchTarget: Record<string, unknown> = { ...current };

  for (const update of updates) {
    if (deepEqual(update.previousValue, update.nextValue)) continue;
    if (!deepEqual(current[update.snakeKey], update.previousValue)) return undefined;
    changed = true;
    if (update.nextValue === undefined) {
      delete patchTarget[update.snakeKey];
      continue;
    }
    if (isPlainObject(update.previousValue) && isPlainObject(update.nextValue)) {
      const sub = splitNewSectionBlocks(
        [update.snakeKey],
        update.previousValue,
        update.nextValue,
        explicitTablePaths,
        inlineTablePaths,
        deferred,
      );
      if (sub === undefined) {
        delete patchTarget[update.snakeKey];
      } else {
        patchTarget[update.snakeKey] = sub;
      }
      continue;
    }
    patchTarget[update.snakeKey] = update.nextValue;
  }

  if (!changed) {
    return verifyPlannedText(originalText, expected) ? originalText : undefined;
  }

  const format = buildPatchFormat(originalText);
  let patched: string;
  try {
    patched = deepEqual(current, patchTarget) ? originalText : patchToml(originalText, patchTarget, format);
  } catch {
    return undefined;
  }

  let result = patched;
  for (const block of deferred) {
    const serialized = serializeSectionBlock(block.path, block.value, format.newLine);
    if (result.trim().length === 0) {
      result = serialized;
    } else {
      if (!result.endsWith('\n')) result += format.newLine;
      if (!result.endsWith(`${format.newLine}${format.newLine}`)) result += format.newLine;
      result += serialized;
    }
  }

  result = preserveLeadingBom(originalText, result);
  return verifyPlannedText(result, expected) ? result : undefined;
}

function isThinkingTable(block: TomlCstBlock): block is TomlCstTable {
  return block.type === 'Table' && block.key.item.value.length === 1 && block.key.item.value[0] === 'thinking';
}

function isPlainEffortMax(item: TomlCstKeyValue): boolean {
  return (
    item.key.value.length === 1 &&
    item.key.value[0] === 'effort' &&
    item.value.type === 'String' &&
    item.value.raw === '"max"'
  );
}

export function replaceThinkingEffortMax(originalText: string): string | undefined {
  let doc;
  try {
    doc = parseDocument(originalText);
  } catch {
    return undefined;
  }
  const thinkingTables = doc.cst.filter(isThinkingTable);
  if (thinkingTables.length !== 1) return undefined;
  const table = thinkingTables[0]!;
  const effortItem = table.items.find(
    (item): item is TomlCstKeyValue => item.type === 'KeyValue' && item.key.value.length === 1 && item.key.value[0] === 'effort',
  );
  if (effortItem === undefined || !isPlainEffortMax(effortItem)) return undefined;

  let parsed: unknown;
  try {
    parsed = parseToml(stripTomlBom(originalText));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed['thinking']) || parsed['thinking']['effort'] !== 'max') {
    return undefined;
  }
  const next: Record<string, unknown> = {
    ...parsed,
    thinking: {
      ...parsed['thinking'],
      effort: 'high',
    },
  };
  try {
    const format = buildPatchFormat(originalText);
    const patched = preserveLeadingBom(originalText, patchToml(originalText, next, format));
    return verifyPlannedText(patched, next) ? patched : undefined;
  } catch {
    return undefined;
  }
}
