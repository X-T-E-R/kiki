import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PORTABLE_SPACE_DOMAINS, type PortableSpaceDiffRow, type PortableSpacePreviewInput } from '@kiki/protocol';
import { git, scratch, writeFileAtomic } from './spaceFiles';
import { matches, object, selectedUnits, type Data, type SpaceUnit, type Units } from './treeProjection';

export interface VerifiedBase {
  hashes: Record<string, string>;
  units: Units;
}
export interface Change {
  row: PortableSpaceDiffRow;
  left: SpaceUnit | undefined;
  right: SpaceUnit | undefined;
  merged?: SpaceUnit;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]));
}

function content(unit: SpaceUnit): string | Buffer {
  if (!Buffer.isBuffer(unit.value)) return JSON.stringify(ordered(unit.value));
  if (unit.domain !== 'memories') return unit.value;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(unit.value.toString('utf8'));
  if (!match) return unit.value;
  try {
    const { revision: _revision, origin: _origin, ...content } = JSON.parse(match[1]!) as Data;
    return JSON.stringify([ordered(content), match[2]?.trim()]);
  } catch { return unit.value; }
}

export function unitHash(unit: SpaceUnit, key: string): string {
  return (unit.domain === 'credentials' ? createHmac('sha256', key) : createHash('sha256')).update(content(unit)).digest('hex');
}

export function unitHashes(units: Units, key: string): Record<string, string> {
  return Object.fromEntries([...units].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, unit]) => [id, unitHash(unit, key)]));
}

export function sameUnit(left: SpaceUnit | undefined, right: SpaceUnit | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && isDeepStrictEqual(content(left), content(right)));
}

export function assignPath(data: Data, path: string[], value: unknown): void {
  if (!path.length || path.some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Invalid portable config key');
  const chain: [Data, string][] = [];
  let target = data;
  for (const part of path.slice(0, -1)) {
    const next = object(target[part]);
    if (target[part] === undefined && value === undefined) return;
    target[part] = next;
    chain.push([target, part]);
    target = next;
  }
  const key = path.at(-1)!;
  if (value === undefined) {
    delete target[key];
    for (const [parent, part] of chain.reverse()) if (!Object.keys(object(parent[part])).length) delete parent[part];
  } else target[key] = value;
}

export function isUnitId(value: string): boolean {
  return PORTABLE_SPACE_DOMAINS.some((domain) => value.startsWith(`${domain}:`));
}

export function applyUnset(units: Units, unset: Iterable<string>): void {
  for (const mask of unset) {
    if (isUnitId(mask)) { units.delete(mask); continue; }
    for (const [id, unit] of units) {
      if (matches(unit, id, mask) || (unit.domain === 'credentials' && unit.key[0] === 'mcp' && `mcp.${unit.key[1]}` === mask)) {
        units.delete(id);
      } else if (!Buffer.isBuffer(unit.value) && mask.startsWith(`${unit.path}.`)) {
        const value = object(unit.value);
        assignPath(value, mask.slice(unit.path.length + 1).split('.'), undefined);
        units.set(id, { ...unit, value });
      }
    }
  }
}

function summary(unit: SpaceUnit | undefined): string | null {
  if (!unit) return null;
  return unit.domain === 'credentials' ? 'Credential (masked)' : Buffer.isBuffer(unit.value) ? `${unit.value.length} bytes` : JSON.stringify(unit.value).slice(0, 512);
}

function diffText(left?: SpaceUnit, right?: SpaceUnit): string | undefined {
  if ((left ?? right)?.domain === 'credentials') return;
  const text = (unit?: SpaceUnit) => unit === undefined ? '' : Buffer.isBuffer(unit.value) ? unit.value.toString('utf8') : JSON.stringify(unit.value, null, 2);
  const a = text(right);
  const b = text(left);
  if (a.includes('\0') || b.includes('\0') || a.includes('\ufffd') || b.includes('\ufffd')) return;
  return `--- target\n+++ source\n${a.split('\n').map((line) => `-${line}`).join('\n')}\n${b.split('\n').map((line) => `+${line}`).join('\n')}`.slice(0, 16_384);
}

function textFile(unit: SpaceUnit | undefined): unit is SpaceUnit & { value: Buffer } {
  return Buffer.isBuffer(unit?.value) && /\.(?:md|toml|json|txt|ya?ml)$/i.test(unit.path) && !unit.value.includes(0);
}

async function mergeText(left: SpaceUnit, base: SpaceUnit | undefined, right: SpaceUnit): Promise<SpaceUnit | undefined> {
  if (!textFile(left) || !textFile(base) || !textFile(right) || left.domain === 'memories') return;
  return scratch(async (dir) => {
    await Promise.all([writeFileAtomic(`${dir}/left`, left.value), writeFileAtomic(`${dir}/base`, base.value), writeFileAtomic(`${dir}/right`, right.value)]);
    try {
      await git(dir, ['merge-file', 'left', 'base', 'right']);
      return { ...left, value: await readFile(`${dir}/left`) };
    } catch (error) {
      if ((error as { code?: number | string }).code === 'ENOENT' || typeof (error as { code?: unknown }).code === 'number') return undefined;
      throw error;
    }
  });
}

export async function planChanges(input: PortableSpacePreviewInput, left: Units, right: Units, masks: ReadonlySet<string>, base: VerifiedBase | undefined, hashKey: string, targetMasks: ReadonlySet<string>): Promise<{ changes: Change[]; unchangedCount: number }> {
  const selectedLeft = selectedUnits(left, input.domains, input.pick);
  const selectedRight = selectedUnits(right, input.domains, input.pick);
  const sync = input.mode === 'sync';
  const changes: Change[] = [];
  let unchangedCount = 0;
  for (const id of [...new Set([...selectedLeft.keys(), ...selectedRight.keys()])].sort()) {
    const l = selectedLeft.get(id);
    const r = selectedRight.get(id);
    const unit = (l ?? r)!;
    if (sameUnit(l, r)) { unchangedCount++; continue; }
    let change: PortableSpaceDiffRow['change'] = l === undefined ? 'deleted' : r === undefined ? 'added' : 'modified';
    let direction: PortableSpaceDiffRow['direction'] = 'to_target';
    let merged: SpaceUnit | undefined;
    if (sync) {
      if (base) {
        const hash = Object.hasOwn(base.hashes, id) ? base.hashes[id] : undefined;
        const leftIsBase = (l && unitHash(l, hashKey)) === hash;
        const rightIsBase = (r && unitHash(r, hashKey)) === hash;
        if (leftIsBase && !rightIsBase) direction = 'to_left';
        else if (rightIsBase && !leftIsBase) direction = 'to_right';
        else if (l && r && (merged = await mergeText(l, base.units.get(id), r))) direction = 'both';
        else { direction = 'conflict'; change = 'conflict'; }
      } else if (!r && ![...targetMasks].some((mask) => matches(unit, id, mask))) { direction = 'to_right'; change = 'only_left'; }
      else if (!l && ![...masks].some((mask) => matches(unit, id, mask))) { direction = 'to_left'; change = 'only_right'; }
      else { direction = 'conflict'; change = 'conflict'; }
      if (change === 'conflict' && input.prefer !== undefined) direction = input.prefer === 'left' ? 'to_right' : 'to_left';
      if (change !== 'conflict' && base) {
        const before = direction === 'to_left' ? l : r;
        const after = direction === 'to_left' ? r : l;
        change = after === undefined ? 'deleted' : before === undefined ? 'added' : 'modified';
      }
    } else {
      const masked = [...masks].some((mask) => matches(unit, id, mask) || mask.startsWith(`${unit.path}.`));
      if (!l && input.mode !== 'replace' && !masked) continue;
      if (input.mode === 'merge' && l && r && (base === undefined || unitHash(r, hashKey) !== base.hashes[id])) {
        change = 'conflict';
        direction = input.prefer === 'left' ? 'to_target' : 'conflict';
      }
    }
    changes.push({ left: l, right: r, merged, row: {
      id, domain: unit.domain, path: unit.path, label: unit.path.slice(0, 256), change, direction,
      beforeSummary: summary(sync ? l : r), afterSummary: summary(sync ? r : merged ?? l),
      diffPreview: diffText(direction === 'to_left' ? r : merged ?? l, direction === 'to_left' ? l : r),
      selected: direction !== 'conflict', masked: unit.domain === 'credentials' || undefined,
    } });
  }
  return { changes, unchangedCount };
}

export function reconcile(changes: Change[], left: Units, right: Units, sync: boolean, selectedIds?: string[], resolutions?: Record<string, 'left' | 'right' | 'skip'>) {
  const leftResult = new Map(left);
  const rightResult = new Map(right);
  const appliedIds: string[] = [];
  const deletedIds: string[] = [];
  const skippedIds: string[] = [];
  const selected = selectedIds === undefined ? undefined : new Set(selectedIds);
  for (const { row, left, right, merged } of changes) {
    const resolution = resolutions?.[row.id];
    const direction = resolution === 'left' ? 'to_right' : resolution === 'right' ? (sync ? 'to_left' : 'none') : row.direction;
    if ((selected && !selected.has(row.id)) || resolution === 'skip' || direction === 'conflict' || direction === 'none') {
      skippedIds.push(row.id); continue;
    }
    let deleted = false;
    for (const [apply, units, value] of [[sync && (direction === 'to_left' || direction === 'both'), leftResult, merged ?? right], [direction !== 'to_left', rightResult, merged ?? left]] as const) {
      if (!apply) continue;
      if (value) units.set(row.id, value);
      else deleted = units.delete(row.id) || deleted;
    }
    if (deleted) deletedIds.push(row.id);
    appliedIds.push(row.id);
  }
  return { leftResult, rightResult, appliedIds, deletedIds, skippedIds };
}

export function modelDependencies(units: Units): string[] {
  const providers = new Set([...units.values()].filter((unit) => unit.domain === 'config' && unit.key[0] === 'providers').map((unit) => unit.key[1]));
  return [...units.values()].flatMap((unit) => {
    if (unit.domain !== 'config' || unit.key[0] !== 'models') return [];
    const provider = object(unit.value)['provider'];
    return typeof provider === 'string' && !providers.has(provider) ? [`Model ${unit.key[1]} references missing provider ${provider}`] : [];
  });
}

