import { register as claude } from './rules/claude/entry.mjs';
import { register as codex } from './rules/codex/entry.mjs';
import * as pi from './rules/pi.mjs';
import * as grok from './rules/grok.mjs';
import * as opencode from './rules/opencode.mjs';
import * as custom from './rules/custom.mjs';

export function register(api) {
  claude(api); codex(api);
  for (const rule of [pi, grok, opencode, custom]) api.registerSessionSource(rule.definition, rule.adapter);
}
