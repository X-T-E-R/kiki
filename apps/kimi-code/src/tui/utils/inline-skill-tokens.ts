/**
 * Scanner for inline skill `/tokens` inside a prompt.
 *
 * Dispatch, editor highlighting, and autocomplete share this so all three
 * agree on what counts as an inline skill reference: a `/name` token whose `/`
 * is preceded by whitespace (space, tab, or newline), with no internal `/`.
 * The leading slash-command area at the very start of the input is handled by
 * the regular slash-command path and is skipped here by default.
 */

import {
  findInlineSkillTokens,
  type FindInlineSkillTokensOptions,
  type InlineSkillToken,
} from '@kiki/session-core/commands/slashCommands';

import type { InlineSkillActivation } from '../types';

export { findInlineSkillTokens, type FindInlineSkillTokensOptions, type InlineSkillToken };

export interface ExtractInlineSkillActivationsOptions {
  /** Also treat a `/` at the very start of the input as a skill token. */
  readonly includeLeading?: boolean;
}

/**
 * Resolve the skill tokens of `text` through `skillCommandMap` (command name →
 * skill name, with the same `skill:` prefix fallback as the leading-command
 * path) and return the deduplicated activations in first-occurrence order.
 * Unknown tokens, paths, URLs, and fractions are ignored.
 */
export function extractInlineSkillActivations(
  text: string,
  skillCommandMap: ReadonlyMap<string, string>,
  options?: ExtractInlineSkillActivationsOptions,
): InlineSkillActivation[] {
  const tokens = findInlineSkillTokens(text, {
    isKnownSkill: (commandName) =>
      skillCommandMap.has(commandName) || skillCommandMap.has(`skill:${commandName}`),
    includeLeading: options?.includeLeading,
  });

  const seen = new Set<string>();
  const activations: InlineSkillActivation[] = [];
  for (const token of tokens) {
    const skillName =
      skillCommandMap.get(token.commandName) ?? skillCommandMap.get(`skill:${token.commandName}`);
    if (skillName === undefined || seen.has(skillName)) continue;
    seen.add(skillName);
    activations.push({ skillName });
  }
  return activations;
}
