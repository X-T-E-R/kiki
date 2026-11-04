import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * Source-labelled, independently bounded title material from live context and the
 * prompt queue; a compacted window need not retain the original opening request.
 * - `user_prompts` (default): up to three earliest available natural-language user prompts.
 * - `first_turn`: earliest available user and its own final assistant text;
 *   unavailable when either side is missing or separated by compaction.
 * - `digest`: earliest available user, up to four later recent user prompts,
 *   live compaction summary, latest user's reply if available, and the previous
 *   generated title as a revisable reference.
 */
export type SessionTitleSource = 'user_prompts' | 'first_turn' | 'digest';

export interface ISessionTitleService {
  readonly _serviceBrand: undefined;

  /** Retries only before model output and cancels on disposal. `force` may replace an existing title, but a title changed during the request wins. */
  generateTitle(opts?: {
    force?: boolean;
    source?: SessionTitleSource;
  }): Promise<string | undefined>;
}

export const ISessionTitleService: ServiceIdentifier<ISessionTitleService> =
  createDecorator<ISessionTitleService>('sessionTitleService');
