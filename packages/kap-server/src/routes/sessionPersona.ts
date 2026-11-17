import {
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentProfileService,
  MAIN_AGENT_ID,
  type Scope,
  type SessionSummary,
} from '@kiki/agent-core-v2';
import { personaIdSchema } from '@kiki/protocol';

function validPersonaId(value: unknown): string | undefined {
  const parsed = personaIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function legacyPersonaId(summary: SessionSummary): string | undefined {
  for (const value of [
    summary.custom?.['bot_persona_id'],
    summary.custom?.['room_persona_id'],
    summary.custom?.['persona_id'],
  ]) {
    const personaId = validPersonaId(value);
    if (personaId !== undefined) return personaId;
  }
  return undefined;
}

export function resolveSessionPersonaId(core: Scope, summary: SessionSummary): string | undefined {
  const main = getLiveSessionById(core.accessor, summary.id)
    ?.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
  const livePersonaId = validPersonaId(main?.accessor.get(IAgentProfileService).data().personaId);
  if (livePersonaId !== undefined) return livePersonaId;
  return validPersonaId(summary.personaId) ?? legacyPersonaId(summary);
}
