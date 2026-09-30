import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { Error2, ErrorCodes } from '#/errors';

export function preparePersonaGreetingReply(accessor: ServicesAccessor): () => void {
  const profile = accessor.get(IAgentProfileService).data();
  const persona = profile.persona;
  const greeting = persona?.definition.greeting;
  if (persona === undefined || greeting === undefined || greeting.trim() === '') {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'This session has no persona greeting to reply to.');
  }
  if ((profile.executorId ?? 'native') !== 'native') {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'Persona greeting replies require the native executor.');
  }
  const context = accessor.get(IAgentContextMemoryService);
  const id = `persona-greeting-${persona.definition.id}`;
  return () => {
    if (context.get().some((message) => message.id === id ||
      (message.origin?.kind === 'persona_greeting' && message.origin.personaId === persona.definition.id))) return;
    context.appendObservable({ id, role: 'assistant', content: [{ type: 'text', text: greeting }], toolCalls: [],
      origin: { kind: 'persona_greeting', personaId: persona.definition.id } });
  };
}
