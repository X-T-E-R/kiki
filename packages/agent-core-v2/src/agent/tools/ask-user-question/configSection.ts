import { z } from 'zod';
import { interactionConfigSchema, questionSettingsFromToml, interactionConfigToWire } from '@kiki/protocol';
import { isPlainObject, cloneRecord, setDefined } from '#/app/config/toml';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const INTERACTION_SECTION = 'interaction';
export const InteractionConfigSchema = interactionConfigSchema;
export type InteractionConfig = z.infer<typeof InteractionConfigSchema>;

registerConfigSection(INTERACTION_SECTION, InteractionConfigSchema, {
  fromToml: questionSettingsFromToml,
  toToml: (value, raw) => {
    if (!isPlainObject(value)) return value;
    const out = cloneRecord(raw);
    for (const [key, field] of Object.entries(interactionConfigToWire(value))) setDefined(out, key, field);
    return out;
  },
});
