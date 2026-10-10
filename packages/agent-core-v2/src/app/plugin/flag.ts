import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const pluginAppLifecycleFlag: FlagDefinitionInput = {
  id: 'plugin_app_lifecycle',
  title: 'App plugin lifecycle',
  description: 'Start explicitly App-activated plugins with Kiki and stop their owned services on shutdown.',
  env: 'KIKI_EXPERIMENTAL_PLUGIN_APP_LIFECYCLE',
  default: true,
  surface: 'both',
};

registerFlagDefinition(pluginAppLifecycleFlag);
