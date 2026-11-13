import type { IncomingMessage } from 'node:http';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { matchConnectionOperation } from '@kiki/protocol';
import type { KlientFrame, KlientProcedure } from '@kiki/klient/host';
import { catalogChangedSchema, searchIndexStateSchema } from '@kiki/klient/contract/global/events';
import { modelSwitchQueuedEventSchema, modelSwitchStatusEventSchema } from '@kiki/klient/contract/agent/modelSwitch';
import { errEnvelope } from '../../envelope';
import { matchesLocalOwner } from '../auth/localOwner';
import type { CredentialValidator } from '../auth/credentials';
import { AdmissionError, ConnectionAdmission } from './admission';

export interface PeerAudience { grantId: string; revision: number }
const peers = new WeakMap<object, PeerAudience>();
export function peerAudience(request: object): PeerAudience | undefined { return peers.get(request); }
export function peerGrant(headers: IncomingMessage['headers']): string | undefined {
  const header = headers['x-kiki-connection-grant'];
  if (typeof header === 'string') return header;
  const protocols = headers['sec-websocket-protocol'];
  return (typeof protocols === 'string' ? protocols.split(',').map((p) => p.trim()) : []).find((p) => p.startsWith('kiki.grant.'))?.slice('kiki.grant.'.length);
}
const peerProcedureMethods: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sessionIndex', new Set(['listRecent', 'get', 'count'])],
  ['sessionMetadata', new Set(['read', 'getAgentExecutor', 'setTitle', 'update', 'setArchived', 'registerAgent'])],
  ['sessionTitleService', new Set(['generateTitle'])],
  ['sessionManager', new Set(['resume', 'restore', 'close', 'archive', 'fork', 'createChild'])],
  ['sessionActivityView', new Set(['state'])],
  ['sessionInteractionService', new Set(['listPending', 'respond', 'acquireConsumer', 'releaseConsumer', 'hasConsumer', 'isRecentlyResolved'])],
  ['sessionApprovalService', new Set(['listPending', 'decide'])],
  ['sessionQuestionService', new Set(['listPending', 'answer', 'dismiss'])],
  ['sessionSkillCatalog', new Set(['list'])],
  ['sessionTodoService', new Set(['getTodos'])],
  ['sessionCronService', new Set(['list', 'getNextFireTime', 'getNextFireForTask'])],
  ['sessionBtwService', new Set(['start'])],
  ['sessionInitService', new Set(['generateAgentsMd', 'cancelInit'])],
  ['agentCollaborationMessagingService', new Set(['sendUserMessage', 'sendUserMessageReceipt'])],
  ['agentLifecycleService', new Set(['countPendingBackgroundTasks', 'drainBackgroundTasks'])],
  ['agentPromptService', new Set(['submit', 'submitAndWait', 'submitSteer', 'switchModel', 'getModelSwitch', 'listModelSwitches', 'updateModelSwitch', 'cancelModelSwitch', 'recoverModelSwitch', 'resumeRecoveredQueue'])],
  ['agentSkillService', new Set(['activate', 'promptWithSkills'])],
  ['agentPluginCommandService', new Set(['activate'])],
  ['agentPluginService', new Set(['refreshSessionStart'])],
  ['agentLoopService', new Set(['cancelFromUser', 'status'])],
  ['agentContextInjectorService', new Set(['reconcileWhenIdle'])],
  ['agentContextMutationService', new Set(['appendImported'])],
  ['agentContextRebuildService', new Set(['rebuild', 'control', 'setEnabled'])],
  ['agentConversationUndoService', new Set(['undo'])],
  ['agentCommandService', new Set(['list'])],
  ['agentRuntimeBindingService', new Set(['get', 'switch'])],
  ['agentTokenCountingService', new Set(['statusSize'])],
  ['agentActivityView', new Set(['state'])],
  ['agentProfileService', new Set(['getModel', 'setModel', 'setEffort', 'getEffectiveThinkingLevel', 'setThinking', 'getModelCapabilities', 'getAgentsMdWarning'])],
  ['agentPermissionModeService', new Set(['mode', 'setMode', 'setModeAndBroadcast'])],
  ['agentUsageService', new Set(['status'])],
  ['agentPlanService', new Set(['status', 'enter', 'exit', 'clear', 'cancel'])],
  ['agentTaskService', new Set(['list', 'readOutput', 'stop', 'stopByUser', 'detach'])],
  ['agentFullCompactionService', new Set(['begin', 'cancel', 'isCompacting', 'getAutoCompact', 'getDefaultAutoCompact', 'setAutoCompactOverride', 'getContextStrategy', 'setContextStrategyOverride'])],
  ['agentGoalService', new Set(['getGoal', 'createGoal', 'updateGoal', 'pauseGoal', 'resumeGoal', 'cancelGoal'])],
  ['agentMcpService', new Set(['list', 'connect', 'reconnect', 'initialLoadDurationMs', 'waitForInitialLoad'])],
  ['agentPanelService', new Set(['read'])],
  ['workspaceService', new Set(['list', 'get'])],
  ['personaStore', new Set(['list', 'get'])],
  ['capabilityService', new Set(['listCapabilities', 'getCapability'])],
  ['authSummaryService', new Set(['summarize', 'ensureReady'])],
  ['oauthService', new Set(['status', 'getFlow', 'listMethods'])],
  ['fileService', new Set(['get'])],
  ['roomService', new Set(['list', 'get', 'listItems', 'log', 'usage', 'searchThreads'])],
  ['botService', new Set(['list', 'ensureHomeSession'])],
  ['taskBoardService', new Set(['read', 'overview'])],
  ['threadCommunicationService', new Set(['hostId', 'listThreads', 'readThread', 'listMessages', 'isWorkspaceEnabled', 'getWorkspaceOverride'])],
  ['modelResolver', new Set(['listModels', 'listProviders', 'getProvider', 'setDefaultModel'])],
  ['modelCatalogMutation', new Set(['readModel', 'readProvider'])],
  ['pluginService', new Set(['listPlugins', 'getPluginInfo', 'listPluginCommands', 'checkUpdates', 'onDidReload'])],
  ['pluginImportService', new Set(['sources', 'jobs', 'job', 'archives', 'read'])],
  ['pluginMediaService', new Set(['sources', 'catalog', 'providers', 'capabilities', 'voices', 'jobs', 'job'])],
  ['agentPluginMediaService', new Set(['cancel', 'resume'])],
]);
const PEER_FRAME_TYPES = ['ping', 'pong', 'view_attach', 'view_detach', 'bridge_attach', 'bridge_detach', 'bridge_response', 'unsubscribe', 'stream_cancel'] as const;
const PEER_EVENT_SERVICES = ['roomService', 'configService', 'sessionMetadata', 'sessionSkillCatalog'] as const;
const peerEventServices = new Set<string>(PEER_EVENT_SERVICES);
const PEER_NO_SERVICE_SUBSCRIBE_EVENTS = ['session', 'agent', 'workspace', 'config', 'sessions', 'workspaces'] as const;
const PEER_BUS_SUBSCRIPTION_EVENT = 'events';
type PeerIdConstraint = 'absent' | 'nonempty';
interface PeerSubscriptionScopeRule {
  readonly scope: 'core' | 'agent' | 'session';
  readonly workspaceId: PeerIdConstraint;
  readonly sessionId: PeerIdConstraint;
  readonly agentId: PeerIdConstraint;
}
const PEER_BUS_SUBSCRIPTION_SCOPES: readonly PeerSubscriptionScopeRule[] = [
  { scope: 'core', workspaceId: 'absent', sessionId: 'absent', agentId: 'absent' },
  { scope: 'agent', workspaceId: 'absent', sessionId: 'nonempty', agentId: 'nonempty' },
];
const PEER_SCOPED_EMITTER_RULES: readonly (PeerSubscriptionScopeRule & { service: string; event: string })[] = [
  { service: 'providerService', event: 'onDidChangeProviders', scope: 'core', workspaceId: 'absent', sessionId: 'absent', agentId: 'absent' },
  { service: 'modelService', event: 'onDidChangeModels', scope: 'core', workspaceId: 'absent', sessionId: 'absent', agentId: 'absent' },
  { service: 'pluginService', event: 'onDidReload', scope: 'core', workspaceId: 'absent', sessionId: 'absent', agentId: 'absent' },
  { service: 'sessionExecutionControl', event: 'onDidChange', scope: 'session', workspaceId: 'absent', sessionId: 'nonempty', agentId: 'absent' },
];
const WEB_RUNTIME_SWITCH_PATH = '/api/runtime-switch';
const WEB_DENIED_PATH_PATTERN = /^\/api\/(?:debug|klient\/(?:delegation|context)|external-delegation|thread-bridge|thread-bridges|usage-export|external-clients|session-access|shutdown)(?:\/|$)/;
const WEB_DENIED_EXACT_PATH = '/mcp';
const WEB_ACCESS_PATH_PREFIX = '/api/web-access';
const WEB_ACCESS_ALLOWED_PATHS = ['/api/web-access/session', '/api/web-access/logout', '/api/web-access/exchange'] as const;
const WEB_REMOTE_CONNECTIONS_PATH = '/api/remote-connections';
const WEB_REMOTE_CONNECTIONS_PREFIX = '/api/remote-connections';
const WEB_REMOTE_CONNECTION_ACTION_PATTERN = /^\/api\/remote-connections\/[0-9a-f-]{36}\/(?:call|download|upload|events|html-preview)$/;
const WEB_BOOTSTRAP_METHODS = ['platform', 'arch', 'cwd', 'osHomeDir', 'homeDir', 'configPath', 'clientVersion', 'clientIdentity', 'sessionsDir', 'blobsDir', 'storeDir', 'cacheDir', 'logsDir'] as const;
const WEB_DENIED_PROCEDURE_SERVICES = ['authTokenService', 'externalDelegationService', 'externalDelegationSeatService'] as const;
function matchesPeerIdConstraint(value: string | undefined, constraint: PeerIdConstraint): boolean {
  return constraint === 'absent' ? value === undefined : typeof value === 'string' && value !== '';
}

function matchesPeerScope(frame: KlientFrame, rule: PeerSubscriptionScopeRule): boolean {
  return frame.scope === rule.scope && matchesPeerIdConstraint(frame.workspaceId, rule.workspaceId) &&
    matchesPeerIdConstraint(frame.sessionId, rule.sessionId) && matchesPeerIdConstraint(frame.agentId, rule.agentId);
}

function peerScopeSummary(rule: PeerSubscriptionScopeRule): string {
  const ids = [
    ['workspaceId', rule.workspaceId],
    ['sessionId', rule.sessionId],
    ['agentId', rule.agentId],
  ] as const;
  const summary: string[] = [];
  const absent = ids.filter(([, constraint]) => constraint === 'absent').map(([id]) => id);
  const nonempty = ids.filter(([, constraint]) => constraint === 'nonempty').map(([id]) => id);
  if (absent.length > 0) summary.push(`${absent.join('/')} absent`);
  if (nonempty.length > 0) summary.push(`${nonempty.join('/')} nonempty`);
  return summary.join('; ');
}

function isPeerScopedEmitterAllowed(frame: KlientFrame): boolean {
  if (typeof frame.service !== 'string' || typeof frame.event !== 'string') return false;
  return PEER_SCOPED_EMITTER_RULES.some((rule) => frame.service === rule.service && frame.event === rule.event && matchesPeerScope(frame, rule));
}
/**
 * Whether an approved GUI peer may invoke this engine procedure.
 *
 * Grants are per service and method, and they mirror what the same grant
 * already reaches over REST: `ConnectionAudience.authorize` admits a REST
 * path only when `matchConnectionOperation` finds it in
 * `CONNECTION_OPERATIONS`, and `/api/klient/call` is itself one of those
 * operations. Every klient facade call a remote client really issues is
 * registered here — remote chat, session reads and lifecycle, approvals,
 * questions, model selection, skills, plugin import, capabilities — so a
 * newly added engine method stays local-owner-only until a remote consumer
 * is registered for it.
 *
 * Writes REST already refuses for a peer stay refused: credential and model
 * registration (`modelService`, `providerService`, `configService`,
 * `mcpManagementService`), persona mutation, workspace registration and
 * removal, plugin install/enable, and session deletion — `sessionManager`
 * grants `fork`/`createChild`, which only derive a session from an existing
 * one, but not `create`, which acquires a workspace lease. Model and provider
 * reads go through the redacted catalog projections (`modelResolver`,
 * `modelCatalogMutation`); the record services behind them carry the stored
 * `apiKey` and are never granted.
 */
export function isPeerProcedureAllowed(procedure: Pick<KlientProcedure, 'service' | 'method'>): boolean {
  return peerProcedureMethods.get(procedure.service)?.has(procedure.method) === true;
}
/**
 * Whether a peer may send this WebSocket frame. Subscribing only binds a
 * listener, so it is keyed to the emitters the remote surface watches rather
 * than to the call grants above; a `subscribe` frame is not a procedure.
 */
export function isPeerFrameAllowed(frame: KlientFrame): boolean {
  if ((PEER_FRAME_TYPES as readonly string[]).includes(frame.type)) return true;
  if (frame.type === 'subscribe') {
    if (frame.service === undefined && frame.event === PEER_BUS_SUBSCRIPTION_EVENT) {
      return PEER_BUS_SUBSCRIPTION_SCOPES.some((rule) => matchesPeerScope(frame, rule));
    }
    return frame.event !== undefined && (frame.service === undefined
      ? (PEER_NO_SERVICE_SUBSCRIBE_EVENTS as readonly string[]).includes(frame.event)
      : peerEventServices.has(frame.service) || isPeerScopedEmitterAllowed(frame));
  }
  return frame.type === 'stream' && typeof frame.service === 'string' && typeof frame.method === 'string' && isPeerProcedureAllowed({ service: frame.service, method: frame.method });
}
/**
 * Projects a peer's existing `events` subscription before WebSocket serialization.
 * Core subscriptions carry only search-index state and model-catalog changes;
 * agent subscriptions carry only model-switch queued/status facts. Existing
 * payload schemas preserve public receipt errors and discard unregistered fields.
 * Unknown types, wrong scopes and invalid payloads never enter the peer socket.
 */
export function projectPeerBusEvent(scope: KlientFrame['scope'], event: unknown): unknown {
  if (event === null || typeof event !== 'object') return undefined;
  const { type, payload } = event as { type?: unknown; payload?: unknown };
  if (scope === 'core') {
    const schema = type === 'event.search.index_state_changed' ? searchIndexStateSchema
      : type === 'event.model_catalog.changed' ? catalogChangedSchema : undefined;
    const parsed = schema?.safeParse(payload);
    return parsed?.success === true ? { type, payload: parsed.data } : undefined;
  }
  if (scope === 'agent') {
    const schema = type === 'prompt.model_switch_queued' ? modelSwitchQueuedEventSchema
      : type === 'prompt.model_switch_status' ? modelSwitchStatusEventSchema : undefined;
    const parsed = schema?.safeParse(event);
    return parsed?.success === true ? parsed.data : undefined;
  }
  return undefined;
}

export function isWebPathAllowed(method: string, path: string): boolean {
  if (path === WEB_RUNTIME_SWITCH_PATH && method !== 'GET') return false;
  if (WEB_DENIED_PATH_PATTERN.test(path) || path === WEB_DENIED_EXACT_PATH) return false;
  if (path.startsWith(WEB_ACCESS_PATH_PREFIX)) return (WEB_ACCESS_ALLOWED_PATHS as readonly string[]).includes(path);
  if (path.startsWith(WEB_REMOTE_CONNECTIONS_PREFIX)) return (method === 'GET' && path === WEB_REMOTE_CONNECTIONS_PATH) || WEB_REMOTE_CONNECTION_ACTION_PATTERN.test(path);
  return true;
}
export function isWebProcedureAllowed(procedure: Pick<KlientProcedure, 'service' | 'method'>): boolean {
  if (procedure.service === 'bootstrapService') return (WEB_BOOTSTRAP_METHODS as readonly string[]).includes(procedure.method);
  return !(WEB_DENIED_PROCEDURE_SERVICES as readonly string[]).includes(procedure.service);
}
export function listPeerReachableSurface(): readonly string[] {
  const surface: string[] = [];
  for (const [service, methods] of peerProcedureMethods) {
    for (const method of methods) surface.push(`PROCEDURE ${service}.${method}`);
  }
  for (const type of PEER_FRAME_TYPES) surface.push(`FRAME ${type}`);
  surface.push('FRAME stream; requires an allowed service.method procedure');
  surface.push('FRAME subscribe');
  for (const rule of PEER_BUS_SUBSCRIPTION_SCOPES) {
    surface.push(`SUBSCRIBE service=none event=${PEER_BUS_SUBSCRIPTION_EVENT} scope=${rule.scope}; ${peerScopeSummary(rule)}`);
  }
  surface.push(`SUBSCRIBE service=none event in ${PEER_NO_SERVICE_SUBSCRIBE_EVENTS.join(',')}; scope and ids unconstrained`);
  for (const service of PEER_EVENT_SERVICES) surface.push(`SUBSCRIBE service=${service} event=any; scope and ids unconstrained`);
  for (const rule of PEER_SCOPED_EMITTER_RULES) {
    surface.push(`SUBSCRIBE service=${rule.service} event=${rule.event} scope=${rule.scope}; ${peerScopeSummary(rule)}`);
  }
  surface.push(`WEB PATH ${WEB_RUNTIME_SWITCH_PATH}: GET only`);
  surface.push(`WEB PATH denied pattern: ${WEB_DENIED_PATH_PATTERN.source}`);
  surface.push(`WEB PATH denied exact: ${WEB_DENIED_EXACT_PATH}`);
  surface.push(`WEB PATH ${WEB_ACCESS_PATH_PREFIX}*: only ${WEB_ACCESS_ALLOWED_PATHS.join(',')}`);
  surface.push(`WEB PATH ${WEB_REMOTE_CONNECTIONS_PREFIX}*: GET ${WEB_REMOTE_CONNECTIONS_PATH} or ${WEB_REMOTE_CONNECTION_ACTION_PATTERN.source}`);
  surface.push('WEB PATH all other paths: allowed');
  surface.push(`WEB PROCEDURE bootstrapService: only ${WEB_BOOTSTRAP_METHODS.join(',')}`);
  surface.push(`WEB PROCEDURE denied services: ${WEB_DENIED_PROCEDURE_SERVICES.join(',')}`);
  surface.push('WEB PROCEDURE all other services: allowed');
  return surface.toSorted();
}
export class ConnectionAudience {
  constructor(readonly admission: ConnectionAdmission, readonly localOwnerToken: string, private readonly validateOwner: CredentialValidator, private readonly currentSpaceId: () => string) {}
  async authorize(token: string, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    try {
      if (matchesLocalOwner(token, this.localOwnerToken)) return true;
      const bearer = this.admission.matchBearer(token);
      if (bearer !== undefined) return this.authorizePeer(bearer, request, reply);
      if (!(await this.validateOwner(token))) throw new AdmissionError(401, 'invalid_owner_credential');
      const path = request.url.split('?', 1)[0]!;
      if (/^\/api\/usage-export(?:\/|$)/.test(path)) throw new AdmissionError(403, 'local_owner_required');
      if (this.admission.unavailableReason === undefined && ((path === '/api/remote-connections/handshake' && request.method === 'GET') || (path === '/api/remote-connections/claim' && request.method === 'POST'))) return true;
      const peer = this.admission.authorize(peerGrant(request.headers));
      if (request.method === 'POST' && path === '/api/remote-connections/pair/cancel') {
        const audience = { grantId: peer.id, revision: peer.revision };
        peers.set(request, audience); peers.set(request.raw, audience); return true;
      }
      return this.bindPeer({ id: peer.id, revision: peer.revision }, request, reply);
    } catch (error) {
      if (!(error instanceof AdmissionError)) throw error;
      await reply.code(error.status).send(errEnvelope(40101, error.reason, request.id)); return false;
    }
  }
  private authorizePeer(peer: { id: string; revision: number }, request: FastifyRequest, reply: FastifyReply): boolean {
    const path = request.url.split('?', 1)[0]!;
    const header = peerGrant(request.headers);
    if (header !== undefined && header !== '') {
      const presented = this.admission.matchBearer(header);
      if (presented === undefined || presented.id !== peer.id) throw new AdmissionError(401, 'connection_not_approved');
    }
    if (path === '/api/remote-connections/handshake' && request.method === 'GET') return true;
    const isPeerBridgeRoute = path === '/api/thread-bridges/peer/outbound' || /^\/api\/thread-bridges\/peer\/outbound\/[0-9a-f-]{36}\/revoke$/.test(path);
    if (request.method === 'POST' && (path === `/api/remote-connections/inbound/grants/${peer.id}/revoke` || path === '/api/remote-connections/pair/cancel' || isPeerBridgeRoute)) {
      const audience = { grantId: peer.id, revision: peer.revision };
      peers.set(request, audience); peers.set(request.raw, audience);
      return true;
    }
    return this.bindPeer(peer, request, reply);
  }
  private bindPeer(peer: { id: string; revision: number }, request: FastifyRequest, reply: FastifyReply): boolean {
    const path = request.url.split('?', 1)[0]!;
    const operation = matchConnectionOperation(request.method, path);
    if (operation === undefined || (operation.params['spaceId'] !== undefined && operation.params['spaceId'] !== this.currentSpaceId())) throw new AdmissionError(403, 'local_owner_required');
    const audience = { grantId: peer.id, revision: peer.revision };
    peers.set(request, audience); peers.set(request.raw, audience);
    const detach = this.admission.attach(peer.id, () => { request.raw.destroy(); reply.raw.destroy(); });
    reply.raw.once('close', detach);
    return true;
  }
  async authorizeSocket(token: string | null, request: IncomingMessage): Promise<PeerAudience | 'local'> {
    if (token !== null && matchesLocalOwner(token, this.localOwnerToken)) return 'local';
    if (token !== null) {
      const bearer = this.admission.matchBearer(token);
      if (bearer !== undefined) {
        if (request.url?.split('?', 1)[0] !== '/api/klient/events') throw new AdmissionError(403, 'local_owner_required');
        const audience = { grantId: bearer.id, revision: bearer.revision }; peers.set(request, audience); return audience;
      }
    }
    if (token === null || !(await this.validateOwner(token))) throw new AdmissionError(401, 'invalid_owner_credential');
    const peer = this.admission.authorize(peerGrant(request.headers));
    if (request.url?.split('?', 1)[0] !== '/api/klient/events') throw new AdmissionError(403, 'local_owner_required');
    const audience = { grantId: peer.id, revision: peer.revision }; peers.set(request, audience); return audience;
  }
}
