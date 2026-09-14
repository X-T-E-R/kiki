import { BugIndicatingError } from '#/_base/errors/errors';
import { collection } from '#/_base/di/collection';

import type { PromptFieldDefinition } from './promptFieldRegistry';

export interface PromptFieldContribution {
  readonly definition: PromptFieldDefinition;
}

export const PromptFieldContribution = collection<PromptFieldContribution>('prompt-field', {
  validate: (value, existing) => {
    const duplicate = existing.find((item) => item.definition.id === value.definition.id);
    if (duplicate !== undefined) {
      throw new BugIndicatingError(`Prompt field "${value.definition.id}" is contributed more than once`);
    }
  },
});

const contributions: PromptFieldContribution[] = [];

export function registerPromptField(definition: PromptFieldDefinition): void {
  if (contributions.some((item) => item.definition.id === definition.id)) {
    throw new BugIndicatingError(`Prompt field "${definition.id}" is registered more than once`);
  }
  contributions.push({ definition });
}

export function getPromptFieldContributions(): readonly PromptFieldContribution[] {
  return contributions;
}

export function _clearPromptFieldContributionsForTests(): void {
  contributions.length = 0;
}
