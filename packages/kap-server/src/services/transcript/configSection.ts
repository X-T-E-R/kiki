import { registerConfigSection, registerFlagDefinition } from '@kiki/agent-core-v2';
import { z } from 'zod';

export const TRANSCRIPT_MEMORY_SECTION = 'transcriptMemory';
export const TRANSCRIPT_RESIDENT_WINDOW_FLAG_ID = 'transcript_resident_window';

export const TranscriptMemoryConfigSchema = z
  .object({
    tailTurns: z.number().int().positive().optional(),
    maxAgentBytes: z.number().int().positive().optional(),
  })
  .strict();

export type TranscriptMemoryConfig = z.infer<typeof TranscriptMemoryConfigSchema>;

export const DEFAULT_TRANSCRIPT_MEMORY_CONFIG: Required<TranscriptMemoryConfig> = {
  tailTurns: 20,
  maxAgentBytes: 16 << 20,
};

registerConfigSection(TRANSCRIPT_MEMORY_SECTION, TranscriptMemoryConfigSchema, {
  defaultValue: DEFAULT_TRANSCRIPT_MEMORY_CONFIG,
});

registerFlagDefinition({
  id: TRANSCRIPT_RESIDENT_WINDOW_FLAG_ID,
  title: 'transcript resident window',
  description: 'Keep completed transcript history in a bounded resident tail backed by durable history.',
  env: 'KIKI_EXPERIMENTAL_TRANSCRIPT_RESIDENT_WINDOW',
  default: false,
  surface: 'core',
});
