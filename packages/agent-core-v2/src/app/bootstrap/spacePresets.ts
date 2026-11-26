import { spaceUiConfigSchema } from '@kiki/protocol';
import {
  findSpacePreset,
  listSpacePresets,
  spacePresetDefaults,
} from '@kiki/kaos/space-home';
import { registerConfigSection } from '#/app/config/configSectionContributions';

registerConfigSection('spaceUi', spaceUiConfigSchema, {
  defaultValue: spaceUiConfigSchema.parse({}),
});

export { findSpacePreset, listSpacePresets, spacePresetDefaults };
