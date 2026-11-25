import type { KlientChannel, ScopeRef } from './channel.js';
import type { Klient, AgentHandle, SessionHandle } from './klient.js';
import type { KlientEventPayloads } from '#/contract/global/events';
import type { SessionEventPayloads } from '#/contract/session/events';
import type { AgentEventPayloads } from '#/contract/agent/events';
import {
  agentEventDescriptors,
  globalEventDescriptors,
  sessionEventDescriptors,
  type EventSourceDescriptor,
} from '#/contract/eventDescriptors';
import { createGlobalFacade, type ScopedCaller, type ScopedStreamCaller } from './facade/global.js';
import { createSessionFacade } from './facade/session.js';
import { createAgentFacade } from './facade/agent.js';
import { createTerminalFacade } from './facade/terminal.js';
import { createSessionViewFacadeCore } from './facade/session-view-core.js';
import { createSessionCommandsFacadeCore } from './facade/session-commands-core.js';
import { EventHub, type KlientEvents } from './events/hub.js';

/**
 * Unvalidated browser-optimized klient factory.
 *
 * Uses the exact same facades, event descriptors, and HTTP channel as
 * `createKlientFromChannel(channel, { validate: false })`, without importing
 * the 60+ Zod contract modules on the browser cold-open critical path.
 */
export function createUnvalidatedKlientFromChannel(channel: KlientChannel): Klient {
  const call: ScopedCaller = async (scope, service, method, args, callOptions) =>
    channel.call(scope, service, method, args, callOptions);

  const callStream: ScopedStreamCaller = (scope, service, method, args) =>
    channel.stream(scope, service, method, args);

  const hubs = new Set<{ close(): void }>();
  const makeHub = <TPayloadMap extends object>(
    scope: ScopeRef,
    registrations: Record<string, EventSourceDescriptor>,
  ): KlientEvents<TPayloadMap> => {
    const hub = new EventHub<TPayloadMap>(channel, false, scope, registrations);
    hubs.add(hub);
    return hub;
  };

  return {
    rest: channel.rest,
    terminal: createTerminalFacade(channel.terminal),
    global: createGlobalFacade(call, callStream),
    events: makeHub<KlientEventPayloads>({}, globalEventDescriptors),
    captureOperation: channel.captureOperation?.bind(channel),
    session(sessionId: string): SessionHandle {
      const scope: ScopeRef = { sessionId };
      return {
        ...createSessionFacade(call, sessionId),
        events: makeHub<SessionEventPayloads>(scope, sessionEventDescriptors),
        view: createSessionViewFacadeCore(channel.sessionView, sessionId),
        commands: createSessionCommandsFacadeCore(channel.sessionCommands, sessionId),
        agent(agentId: string): AgentHandle {
          const agentScope: ScopeRef = { sessionId, agentId };
          return {
            ...createAgentFacade(call, agentScope),
            events: makeHub<AgentEventPayloads>(agentScope, agentEventDescriptors),
          };
        },
      };
    },
    close: () => {
      for (const hub of hubs) {
        hub.close();
      }
      hubs.clear();
      return channel.close();
    },
  };
}
