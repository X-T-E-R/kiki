import { definition } from './lib/definitions.mjs';
import { extractDocument } from './lib/documents.mjs';

export function register(api) {
  api.registerTool(definition, extractDocument);
}
