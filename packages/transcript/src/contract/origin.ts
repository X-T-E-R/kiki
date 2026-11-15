import { z } from 'zod';
import type { TranscriptSkillActivation, TranscriptUserOrigin, TranscriptUserOriginVia } from '../model/frame';
import { agentReferenceSchema } from './agentReference';

export const transcriptUserOriginViaSchema = z.object({
  client: z.string(),
  channel: z.enum(['owner', 'terminal']),
});

export function projectTranscriptUserOrigin(origin: unknown): TranscriptUserOrigin | undefined {
  const candidate = origin as
    | { readonly kind?: unknown; readonly via?: unknown; readonly skillActivations?: unknown; readonly agentRefs?: unknown }
    | undefined;
  if (candidate?.kind !== 'user') return undefined;
  const parsedVia = transcriptUserOriginViaSchema.safeParse(candidate.via);
  const via: TranscriptUserOriginVia | undefined = parsedVia.success ? parsedVia.data : undefined;
  const parsedRefs = agentReferenceSchema.array().safeParse(candidate.agentRefs);
  const agentRefs = parsedRefs.success && parsedRefs.data.length > 0 ? parsedRefs.data : undefined;
  if (!Array.isArray(candidate.skillActivations)) {
    if (via === undefined && agentRefs === undefined) return { kind: 'user' };
    return { kind: 'user', via, agentRefs };
  }
  const skillActivations = candidate.skillActivations.flatMap(
    (activation): TranscriptSkillActivation[] => {
      if (typeof activation !== 'object' || activation === null) return [];
      const value = activation as { readonly skillName?: unknown; readonly skillArgs?: unknown };
      if (typeof value.skillName !== 'string') return [];
      return [
        {
          skillName: value.skillName,
          skillArgs: typeof value.skillArgs === 'string' ? value.skillArgs : undefined,
        },
      ];
    },
  );
  return {
    kind: 'user',
    via,
    skillActivations: skillActivations.length > 0 ? skillActivations : undefined,
    agentRefs,
  };
}
