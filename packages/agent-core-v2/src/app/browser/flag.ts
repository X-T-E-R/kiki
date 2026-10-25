import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const NATIVE_BROWSER_FLAG_ID = 'native_browser';
registerFlagDefinition({ id: NATIVE_BROWSER_FLAG_ID, title: 'Native browser control',
  description: 'Use saved browser connections with the managed agent-browser execution backend.',
  env: 'KIKI_EXPERIMENTAL_NATIVE_BROWSER', default: true, surface: 'core' });
