import type { RequestIdentityWireOptions } from '#/kosong/contract/provider';
import type { Protocol } from '#/kosong/protocol/protocol';
import type { ResolvedRequestIdentityPolicy } from './requestIdentityPolicy';
import type { RequestIdentitySnapshot } from '#/session/requestIdentity/requestIdentityRegistry';
import { Error2 } from '#/_base/errors/errors';
import { RequestIdentityErrors } from './errors';

export const SUPPRESS_USER_AGENT_HEADER = 'x-kiki-internal-suppress-user-agent';
export const SUPPRESS_REQUEST_IDENTITY_HEADER = 'x-kiki-internal-suppress-request-identity';

export interface RequestIdentityProjection {
  readonly headers?: Readonly<Record<string, string>>;
  readonly cacheKey?: string;
  readonly wire?: RequestIdentityWireOptions;
}

export function projectRequestIdentity(input: {
  readonly policy: ResolvedRequestIdentityPolicy;
  readonly protocol: Protocol;
  readonly model: string;
  readonly rawSessionId: string;
  readonly rawAgentId: string;
  readonly parentAgentId?: string;
  readonly subagentKind?: string;
  readonly snapshot: RequestIdentitySnapshot;
  readonly runtimeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): RequestIdentityProjection {
  const protocol = protocolFamily(input.protocol);
  const policy = input.policy;
  const trueNone = isTrueNone(policy);
  if (policy.responsesMetadata === 'codex' && protocol !== 'responses') {
    throw unsupported('Codex-compatible request identity only supports OpenAI Responses');
  }
  if (policy.lineage.format === 'codex' && policy.source === 'new' && protocol !== 'responses') {
    throw unsupported('Codex-compatible request identity only supports OpenAI Responses');
  }
  if (policy.lineage.format === 'grok_build' && protocol === 'other') {
    throw unsupported('Grok Build-compatible request identity requires Responses or Messages');
  }
  if (policy.client.userAgent === 'none' && protocol === 'other') {
    throw unsupported('true none requires an adapter with a final fetch suppression seam');
  }
  const cacheSession = requestSessionIdentity(input);
  const cacheKey =
    policy.cache.source !== 'session'
      ? undefined
      : policy.source === 'legacy'
        ? cacheSession
        : protocol === 'responses' && policy.cache.responses === 'prompt_cache_key'
          ? cacheSession
          : protocol === 'messages' && policy.cache.messages === 'metadata_user_id'
            ? cacheSession
            : protocol === 'other' && policy.preset === 'kiki'
              ? cacheSession
              : undefined;
  const headers: Record<string, string> = {};
  if (policy.lineage.format === 'codex') {
    const sessionId = cacheSession;
    const threadId = policy.source === 'legacy' ? input.rawAgentId : input.snapshot.threadId;
    if (policy.lineage.sessionScope !== 'none') headers['session-id'] = sessionId;
    if (policy.lineage.threadIdentity === 'agent') {
      headers['thread-id'] = threadId;
      if (policy.source === 'new') headers['x-client-request-id'] = threadId;
    }
    if (policy.lineage.parentThread === 'immediate_agent' && input.parentAgentId !== undefined) {
      headers['x-codex-parent-thread-id'] =
        policy.source === 'legacy'
          ? input.parentAgentId
          : (input.snapshot.parentThreadId ?? input.parentAgentId);
    }
    if (policy.lineage.subagentMarker === 'enabled' && input.subagentKind !== undefined) {
      headers['x-openai-subagent'] = 'collab_spawn';
    }
    if (policy.responsesMetadata === 'codex' && policy.lineage.threadIdentity === 'agent') {
      headers['x-codex-window-id'] = input.snapshot.windowId;
      if (input.snapshot.turnState !== undefined) {
        headers['x-codex-turn-state'] = input.snapshot.turnState;
      }
    }
  } else if (policy.lineage.format === 'grok_build') {
    if (policy.lineage.sessionScope !== 'none') {
      headers['x-grok-conv-id'] = cacheSession;
      headers['x-grok-session-id'] = cacheSession;
    }
    if (policy.request.logicalId === 'turn') headers['x-grok-req-id'] = input.snapshot.logicalId;
    if (policy.request.turnIndex === 'agent_session') {
      headers['x-grok-turn-idx'] = String(input.snapshot.turnIndex);
    }
    if (policy.client.installationIdentity === 'persistent_local') {
      headers['x-grok-agent-id'] = input.snapshot.installationId;
    }
    headers['x-grok-client-identifier'] = 'grok-shell';
    headers['x-grok-client-version'] = input.runtimeVersion;
    headers['x-grok-model-override'] = input.model;
  } else if (policy.lineage.format === 'kiki') {
    if (policy.lineage.sessionScope !== 'none') headers['x-kiki-session-id'] = cacheSession;
    if (policy.lineage.threadIdentity === 'agent') headers['x-kiki-agent-id'] = input.rawAgentId;
    if (policy.lineage.parentThread === 'immediate_agent' && input.parentAgentId !== undefined) {
      headers['x-kiki-parent-agent-id'] = input.parentAgentId;
    }
    if (policy.lineage.subagentMarker === 'enabled' && input.subagentKind !== undefined) {
      headers['x-kiki-subagent'] = input.subagentKind;
    }
  }
  if (policy.client.originator.mode === 'codex_default') {
    headers['originator'] = 'codex_cli_rs';
  } else if (policy.client.originator.mode === 'custom') {
    headers['originator'] = policy.client.originator.value;
  }
  if (policy.client.userAgent === 'codex') {
    headers['User-Agent'] = `codex_cli_rs/${input.runtimeVersion} (${input.platform}; ${input.arch})`;
  } else if (policy.client.userAgent === 'grok_build') {
    headers['User-Agent'] = `grok-shell/${input.runtimeVersion} (${input.platform}; ${input.arch})`;
  } else if (policy.client.userAgent === 'none') {
    headers[trueNone ? SUPPRESS_REQUEST_IDENTITY_HEADER : SUPPRESS_USER_AGENT_HEADER] = '1';
  }
  let responsesClientMetadata: Record<string, string> | undefined;
  if (policy.responsesMetadata === 'codex') {
    const canonical = codexTurnMetadata(input);
    const canonicalJson = JSON.stringify(canonical);
    responsesClientMetadata = { 'x-codex-turn-metadata': canonicalJson };
    if (policy.client.installationIdentity === 'persistent_local') {
      responsesClientMetadata['x-codex-installation-id'] = input.snapshot.installationId;
    }
    if (policy.lineage.sessionScope !== 'none') {
      responsesClientMetadata['session_id'] = cacheSession;
    }
    if (policy.lineage.threadIdentity === 'agent') {
      responsesClientMetadata['thread_id'] = input.snapshot.threadId;
      responsesClientMetadata['x-codex-window-id'] = input.snapshot.windowId;
    }
    if (policy.request.logicalId === 'turn') {
      responsesClientMetadata['turn_id'] = input.snapshot.logicalId;
    }
    headers['x-codex-turn-metadata'] = canonicalJson;
    if (headers['x-codex-parent-thread-id'] !== undefined) {
      responsesClientMetadata['x-codex-parent-thread-id'] = headers['x-codex-parent-thread-id'];
    }
    if (policy.lineage.subagentMarker === 'enabled' && input.subagentKind !== undefined) {
      responsesClientMetadata['x-openai-subagent'] = 'collab_spawn';
    }
    if (policy.lineage.turnAncestry === 'spawn_context' && input.snapshot.parentTurnId !== undefined) {
      responsesClientMetadata['parent_turn_id'] = input.snapshot.parentTurnId;
    }
    if (policy.lineage.turnAncestry === 'spawn_context' && input.snapshot.rootTurnId !== undefined) {
      responsesClientMetadata['root_turn_id'] = input.snapshot.rootTurnId;
    }
  }
  return {
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    cacheKey,
    wire:
      policy.source === 'new' || policy.client.userAgent === 'none' || responsesClientMetadata !== undefined
        ? {
            suppressUserAgent: policy.client.userAgent === 'none',
            suppressIdentity: trueNone,
            suppressMessagesMetadataUserId: policy.source === 'new',
            responsesClientMetadata,
            onResponseHeaders:
              responsesClientMetadata === undefined
                ? undefined
                : (responseHeaders) => {
                    const state = responseHeaders.get('x-codex-turn-state');
                    if (state !== null && state.length > 0) input.snapshot.setTurnState(state);
                  },
          }
        : undefined,
  };
}

function codexTurnMetadata(input: Parameters<typeof projectRequestIdentity>[0]) {
  const policy = input.policy;
  const metadata: Record<string, string> = { request_kind: 'turn' };
  if (policy.client.installationIdentity === 'persistent_local') {
    metadata['installation_id'] = input.snapshot.installationId;
  }
  if (policy.lineage.sessionScope !== 'none') metadata['session_id'] = requestSessionIdentity(input);
  if (policy.lineage.threadIdentity === 'agent') {
    metadata['thread_id'] = input.snapshot.threadId;
    metadata['window_id'] = input.snapshot.windowId;
  }
  if (policy.request.logicalId === 'turn') metadata['turn_id'] = input.snapshot.logicalId;
  if (policy.lineage.turnAncestry === 'spawn_context' && input.snapshot.parentTurnId !== undefined) {
    metadata['parent_turn_id'] = input.snapshot.parentTurnId;
  }
  if (policy.lineage.turnAncestry === 'spawn_context' && input.snapshot.rootTurnId !== undefined) {
    metadata['root_turn_id'] = input.snapshot.rootTurnId;
  }
  if (policy.lineage.subagentMarker === 'enabled' && input.subagentKind !== undefined) {
    metadata['subagent_kind'] = input.subagentKind;
  }
  return metadata;
}

function isTrueNone(policy: ResolvedRequestIdentityPolicy): boolean {
  return (
    policy.lineage.format === 'none' &&
    policy.lineage.sessionScope === 'none' &&
    policy.lineage.threadIdentity === 'none' &&
    policy.lineage.parentThread === 'none' &&
    policy.lineage.subagentMarker === 'none' &&
    policy.lineage.turnAncestry === 'none' &&
    policy.client.installationIdentity === 'none' &&
    policy.client.originator.mode === 'none' &&
    policy.client.userAgent === 'none' &&
    policy.request.logicalId === 'none' &&
    policy.request.turnIndex === 'none' &&
    policy.cache.source === 'none' &&
    policy.cache.responses === 'none' &&
    policy.cache.messages === 'none' &&
    policy.responsesMetadata === 'none'
  );
}

function requestSessionIdentity(input: Parameters<typeof projectRequestIdentity>[0]): string {
  if (input.policy.lineage.sessionScope === 'agent_session') return input.snapshot.agentSessionId;
  if (input.policy.source === 'legacy' || input.policy.preset === 'kiki') return input.rawSessionId;
  return input.snapshot.sharedSessionId;
}

function protocolFamily(protocol: Protocol): 'responses' | 'messages' | 'other' {
  if (protocol === 'openai_responses') return 'responses';
  if (protocol === 'anthropic') return 'messages';
  return 'other';
}

function unsupported(message: string): Error {
  return new Error2(RequestIdentityErrors.codes.REQUEST_IDENTITY_UNSUPPORTED, message);
}
