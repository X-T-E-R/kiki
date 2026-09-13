export { RPCError } from './core/errors.js';
export { IAgentPanelService } from './transports/agentPanelService.js';
export type { EventSourceRef, IDisposable, ScopeRef } from './core/channel.js';
export {
  createContractDispatcher as createKlientDispatcher,
  type ContractDispatcher as KlientDispatcher,
} from './transports/contractDispatcher.js';
export type { ScopeLike } from './transports/memory/dispatcher.js';
export {
  decodeJsonFrame,
  encodeJsonFrame,
  eventSourceFromTarget,
  isTransportScope,
  parseKlientCallRequest,
  scopeRefFromProcedure,
  scopeRefFromTarget,
  type KlientCallRequest,
  type KlientFrame,
  type KlientProcedure,
  type KlientTarget,
  type TransportScope,
} from './transports/codec.js';
