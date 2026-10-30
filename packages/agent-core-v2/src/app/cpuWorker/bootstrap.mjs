import { register } from 'node:module';
import { tsImport } from 'tsx/esm/api';

register('../../../../../build/raw-text-loader.mjs', import.meta.url);
await tsImport('./entry.ts', import.meta.url);
