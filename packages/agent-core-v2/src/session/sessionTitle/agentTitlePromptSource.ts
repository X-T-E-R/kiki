import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const MAX_TITLE_RECENT_USER_PROMPTS = 4;

/** The earliest available user prompt and its own reply; either may be unavailable. */
export interface TitleTurnExcerpt {
  readonly user?: string;
  readonly assistant?: string;
}

/** Bounded sources from the live window, not a second model-generated summary. */
export interface TitleDigestExcerpt {
  readonly firstUser?: string;
  readonly recentUsers: readonly string[];
  readonly summary?: string;
  readonly assistant?: string;
}

export interface IAgentTitlePromptSource {
  readonly _serviceBrand: undefined;

  firstUserPrompts(limit: number): Promise<readonly string[]>;

  firstTurnExcerpt(): Promise<TitleTurnExcerpt>;

  digestExcerpt(): Promise<TitleDigestExcerpt>;
}

export const IAgentTitlePromptSource: ServiceIdentifier<IAgentTitlePromptSource> =
  createDecorator<IAgentTitlePromptSource>('agentTitlePromptSource');
