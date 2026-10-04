import { registerFlagDefinition } from '#/app/flag/flagRegistry';

registerFlagDefinition({
  id: 'plugin_import', title: 'History import',
  description: 'Import external text history into continuable Kiki sessions or read-only archives using built-in rules or trusted custom scripts.',
  env: 'KIKI_EXPERIMENTAL_PLUGIN_IMPORT', default: true, surface: 'core',
});
