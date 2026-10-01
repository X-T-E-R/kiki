import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'pathe';
import { parse } from 'smol-toml';

import { spaceColorSchema, spaceIdSchema, spaceNameSchema, spacePresetIdSchema } from '@kiki/protocol';

import { findSpacePreset } from './spacePresets';

import { isPlainObject } from '#/app/config/configPure';

export interface SpaceHome {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly preset?: string;
  readonly baseHomeDir?: string;
  readonly inherit: {
    readonly config: boolean;
    readonly credentials: 'shared' | 'isolated';
    readonly agents: boolean;
    readonly instructions: boolean | 'stack';
    readonly skills: boolean;
    readonly mcp: boolean;
    readonly appearance: boolean;
    readonly plugins: boolean;
    readonly genericRoots: boolean;
  };
}

export function readSpaceHome(homeDir: string): { readonly space?: SpaceHome; readonly diagnostic?: string } {
  let text: string;
  try {
    text = readFileSync(join(homeDir, 'home.toml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { diagnostic: `Cannot read home.toml: ${String(error)}` };
  }
  try {
    const raw: unknown = parse(text);
    if (
      !isPlainObject(raw) || raw['schema'] !== 1 ||
      typeof raw['id'] !== 'string' || !spaceIdSchema.safeParse(raw['id']).success
    ) {
      throw new Error('schema = 1 and a stable h- id are required');
    }
    const preset = raw['preset'] === undefined ? undefined : spacePresetIdSchema.parse(raw['preset']);
    const defaults = findSpacePreset(preset ?? 'kiki') ?? findSpacePreset('kiki')!;
    const name = spaceNameSchema.parse(raw['name'] ?? defaults.name);
    const color = raw['color'] === undefined ? defaults.color : spaceColorSchema.parse(raw['color']);
    const inherit = raw['inherit'] ?? {};
    if (!isPlainObject(inherit)) throw new Error('inherit must be a table');
    const flag = (key: string, fallback: boolean): boolean => {
      const value = inherit[key] ?? fallback;
      if (typeof value !== 'boolean') throw new Error(`inherit.${key} must be a boolean`);
      return value;
    };
    const credentials = inherit['credentials'] ?? 'shared';
    if (credentials !== 'shared' && credentials !== 'isolated') throw new Error('inherit.credentials must be shared or isolated');
    const instructions = inherit['instructions'] ?? true;
    if (typeof instructions !== 'boolean' && instructions !== 'stack') throw new Error('inherit.instructions must be a boolean or stack');
    let baseHomeDir: string | undefined;
    if (raw['base'] !== undefined) {
      if (typeof raw['base'] !== 'string' || !isAbsolute(raw['base'])) throw new Error('base must be an absolute path');
      baseHomeDir = normalize(raw['base']);
      if ((process.platform === 'win32' ? baseHomeDir.toLowerCase() : baseHomeDir) === (process.platform === 'win32' ? normalize(homeDir).toLowerCase() : normalize(homeDir))) throw new Error('base cannot be this home');
      try {
        readFileSync(join(baseHomeDir, 'home.toml'));
        throw new Error('multi-level inheritance is not supported');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { space: {
      id: raw['id'], name, color, preset, baseHomeDir,
      inherit: {
        config: flag('config', true), credentials,
        agents: flag('agents', true), instructions, skills: flag('skills', true),
        mcp: flag('mcp', true), appearance: flag('appearance', true),
        plugins: flag('plugins', false), genericRoots: flag('generic_roots', true),
      },
    } };
  } catch (error) {
    return { diagnostic: `Invalid home.toml: ${error instanceof Error ? error.message : String(error)}` };
  }
}
