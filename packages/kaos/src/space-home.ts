import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'pathe';
import { parse } from 'smol-toml';
import { z } from 'zod';
import {
  spaceColorSchema,
  spaceIdSchema,
  spaceNameSchema,
  spacePresetIdSchema,
  spacePresetSchema,
  type SpacePreset,
} from '@kiki/protocol';

const BUNDLED_CATALOG_TOML = `[[presets]]
id = "kiki"
name = "Kiki"
description = "A general-purpose space."

[presets.defaults.space_ui]
default_skin = "paper"
landing_page = "/new"
plugins = []
`;

const catalogSchema = z.object({
  presets: z
    .array(spacePresetSchema.extend({ defaults: z.record(z.string(), z.unknown()) }))
    .min(1),
});

const presets = catalogSchema.parse(parse(BUNDLED_CATALOG_TOML)).presets;
const baseline = presets.find((preset) => preset.id === 'kiki');
if (baseline === undefined || new Set(presets.map((preset) => preset.id)).size !== presets.length) {
  throw new Error('Bundled space presets must have unique ids and a kiki baseline');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SpaceSourceSelections {
  readonly groups?: Record<string, 'follow' | 'fixed'>;
  readonly selections?: Record<string, { mode: 'follow' | 'fixed'; excluded?: boolean }>;
}

export interface SpaceHome {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly preset?: string;
  readonly baseHomeDir?: string;
  readonly resourceBaseHomeDir?: string;
  readonly sourceSelections?: SpaceSourceSelections;
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

export function listSpacePresets(): SpacePreset[] {
  return presets.map((preset) => spacePresetSchema.parse(preset));
}

export function findSpacePreset(id: string): SpacePreset | undefined {
  const preset = presets.find((item) => item.id === id);
  return preset === undefined ? undefined : spacePresetSchema.parse(preset);
}

export function spacePresetDefaults(id = 'kiki'): Record<string, unknown> {
  const preset = presets.find((item) => item.id === id) ?? baseline!;
  return structuredClone(preset.defaults);
}

export function readSpaceHome(homeDir: string): {
  readonly space?: SpaceHome;
  readonly diagnostic?: string;
} {
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
      !isPlainObject(raw) ||
      raw['schema'] !== 1 ||
      typeof raw['id'] !== 'string' ||
      !spaceIdSchema.safeParse(raw['id']).success
    ) {
      throw new Error('schema = 1 and a stable h- id are required');
    }
    const preset =
      raw['preset'] === undefined ? undefined : spacePresetIdSchema.parse(raw['preset']);
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
    if (credentials !== 'shared' && credentials !== 'isolated') {
      throw new Error('inherit.credentials must be shared or isolated');
    }
    const instructions = inherit['instructions'] ?? true;
    if (typeof instructions !== 'boolean' && instructions !== 'stack') {
      throw new Error('inherit.instructions must be a boolean or stack');
    }
    let baseHomeDir: string | undefined;
    if (raw['base'] !== undefined) {
      if (typeof raw['base'] !== 'string' || !isAbsolute(raw['base'])) {
        throw new Error('base must be an absolute path');
      }
      baseHomeDir = normalize(raw['base']);
      const selfComparable =
        process.platform === 'win32' ? normalize(homeDir).toLowerCase() : normalize(homeDir);
      const baseComparable =
        process.platform === 'win32' ? baseHomeDir.toLowerCase() : baseHomeDir;
      if (baseComparable === selfComparable) {
        throw new Error('base cannot be this home');
      }
      try {
        readFileSync(join(baseHomeDir, 'home.toml'));
        throw new Error('multi-level inheritance is not supported');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return {
      space: {
        id: raw['id'],
        name,
        color,
        preset,
        baseHomeDir,
        inherit: {
          config: flag('config', true),
          credentials,
          agents: flag('agents', true),
          instructions,
          skills: flag('skills', true),
          mcp: flag('mcp', true),
          appearance: flag('appearance', true),
          plugins: flag('plugins', false),
          genericRoots: flag('generic_roots', true),
        },
      },
    };
  } catch (error) {
    return {
      diagnostic: `Invalid home.toml: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
