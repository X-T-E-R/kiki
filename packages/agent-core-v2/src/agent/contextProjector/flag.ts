import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const degradeStaleHeavyMediaFlag: FlagDefinitionInput = {
  id: 'degrade_stale_heavy_media',
  title: 'Degrade stale heavy media',
  description:
    'Replace older video and audio attachments with re-readable placeholders before model requests to reduce upload size.',
  env: 'KIKI_EXPERIMENTAL_DEGRADE_STALE_HEAVY_MEDIA',
  default: false,
  surface: 'both',
};

registerFlagDefinition(degradeStaleHeavyMediaFlag);
