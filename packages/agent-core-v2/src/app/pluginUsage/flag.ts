import { registerFlagDefinition } from '#/app/flag/flagRegistry';
export const PLUGIN_WORKSPACE_USAGE_FLAG = 'plugin_workspace_usage';
registerFlagDefinition({ id: PLUGIN_WORKSPACE_USAGE_FLAG, title: 'Workspace plugin selection', description: 'Choose which installed plugins contribute to each workspace.', env: 'KIKI_EXPERIMENTAL_PLUGIN_WORKSPACE_USAGE', default: true, surface: 'both' });
