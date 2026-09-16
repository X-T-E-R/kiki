import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

/** The opt-in `[thread_communication]` section owned by the `threadCommunication` domain. */
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
