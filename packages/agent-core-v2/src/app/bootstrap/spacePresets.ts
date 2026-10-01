import { parse } from 'smol-toml';
import { spacePresetSchema, spaceUiConfigSchema, type SpacePreset } from '@kiki/protocol';

import { z } from 'zod';
import catalog from './presets/catalog.toml?raw';
import { registerConfigSection } from '#/app/config/configSectionContributions';

const catalogSchema = z.object({
  presets: z.array(spacePresetSchema.extend({ defaults: z.record(z.string(), z.unknown()) })).min(1),
});
const presets = catalogSchema.parse(parse(catalog)).presets;
const baseline = presets.find((preset) => preset.id === 'kiki');
if (baseline === undefined || new Set(presets.map((preset) => preset.id)).size !== presets.length) {
  throw new Error('Bundled space presets must have unique ids and a kiki baseline');
}

registerConfigSection('spaceUi', spaceUiConfigSchema, {
  defaultValue: spaceUiConfigSchema.parse({}),
});

export function listSpacePresets(): SpacePreset[] {
  return presets.map((preset) => spacePresetSchema.parse(preset));
}

export function findSpacePreset(id: string): SpacePreset | undefined {
  const preset = presets.find((preset) => preset.id === id);
  return preset === undefined ? undefined : spacePresetSchema.parse(preset);
}

export function spacePresetDefaults(id = 'kiki'): Record<string, unknown> {
  const preset = presets.find((preset) => preset.id === id) ?? baseline!;
  return structuredClone(preset.defaults);
}
