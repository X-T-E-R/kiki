import type { TranscriptSkillActivation, TranscriptUserOrigin } from '../model/frame';
import { agentReferenceSchema } from './agentReference';

export function projectTranscriptUserOrigin(origin: unknown): TranscriptUserOrigin | undefined {
  const candidate = origin as
    | { readonly kind?: unknown; readonly skillActivations?: unknown; readonly agentRefs?: unknown }
    | undefined;
  if (candidate?.kind !== 'user') return undefined;
  const parsedRefs = agentReferenceSchema.array().safeParse(candidate.agentRefs);
  const agentRefs = parsedRefs.success && parsedRefs.data.length > 0 ? parsedRefs.data : undefined;
  if (!Array.isArray(candidate.skillActivations)) return agentRefs === undefined ? { kind: 'user' } : { kind: 'user', agentRefs };
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
    skillActivations: skillActivations.length > 0 ? skillActivations : undefined,
    agentRefs,
  };
}
