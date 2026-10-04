import { registerFlagDefinition } from '#/app/flag/flagRegistry';

registerFlagDefinition({ id: 'media_generation', title: 'Media generation plugins', description: 'Generate image, video and speech files with installed media providers.', env: 'KIKI_EXPERIMENTAL_MEDIA_GENERATION', default: false, surface: 'both' });
