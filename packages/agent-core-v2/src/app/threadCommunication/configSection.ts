/**
 * `threadCommunication` domain — registers the global thread-communication preference.
 *
 * Owns the opt-in `[thread_communication]` section. Bound at App scope.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const THREAD_COMMUNICATION_SECTION = 'threadCommunication';

export const ThreadCommunicationConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();

export type ThreadCommunicationConfig = z.infer<typeof ThreadCommunicationConfigSchema>;

registerConfigSection(THREAD_COMMUNICATION_SECTION, ThreadCommunicationConfigSchema, {
  defaultValue: { enabled: false },
});
