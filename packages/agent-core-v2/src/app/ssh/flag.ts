import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const NATIVE_SSH_FLAG_ID = 'native_ssh';

registerFlagDefinition({
  id: NATIVE_SSH_FLAG_ID,
  title: 'native SSH hosts',
  description: 'Use SSH hosts from local or remote workspaces.',
  env: 'KIKI_EXPERIMENTAL_NATIVE_SSH',
  default: true,
  surface: 'core',
});
