import { registerFlagDefinition } from '@kiki/agent-core-v2';

export const WORK_PRESETS_FLAG = 'work_presets';
registerFlagDefinition({ id: WORK_PRESETS_FLAG, title: 'Window work presets', env: 'KIKI_EXPERIMENTAL_WORK_PRESETS', surface: 'both', default: false, description: 'Enable space-local work modes and their explicit package setup flow.' });
