import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { register as registerTypeScript } from 'tsx/esm/api';

registerTypeScript({ tsconfig: fileURLToPath(new URL('../../../../../agent-core-v2/tsconfig.json', import.meta.url)) });
register('../../../../../../build/raw-text-loader.mjs', import.meta.url);
await import('./entry.ts');
