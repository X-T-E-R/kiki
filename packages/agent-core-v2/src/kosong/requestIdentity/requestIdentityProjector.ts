import type { RequestIdentityWireOptions } from '#/kosong/contract/provider';
import { arch as hostArch, hostname, release, type as osType } from 'node:os';
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
  readonly isKimiProvider: boolean;
  readonly snapshot: RequestIdentitySnapshot;
  readonly runtimeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly hostRequestHeaders?: Readonly<Record<string, string>>;
}): RequestIdentityProjection {
  preflightRequestIdentityProjection(input.policy, input.protocol);
  const protocol = protocolFamily(input.protocol);
  const policy = input.policy;
  const trueNone = isTrueNone(policy);
  let resolvedSessionIdentity: string | undefined;
  const sessionIdentity = (): string =>
    (resolvedSessionIdentity ??= requestSessionIdentity(input));
  const cacheKey =
    policy.cache.source !== 'session'
      ? undefined
      : protocol === 'responses' && policy.cache.responses === 'prompt_cache_key'
        ? sessionIdentity()
        : protocol === 'messages' && policy.cache.messages === 'metadata_user_id'
          ? sessionIdentity()
          : protocol === 'other' && policy.preset === 'kimi_code'
            ? sessionIdentity()
            : undefined;
  const headers: Record<string, string> = {};
  if (policy.lineage.format === 'codex') {
    if (policy.lineage.sessionScope !== 'none') {
      headers['session-id'] = sessionIdentity();
    }
    if (policy.lineage.threadIdentity === 'agent') {
      const threadId = requiredSnapshot(input.snapshot.threadId, 'thread identity');
      headers['thread-id'] = threadId;
      headers['x-client-request-id'] = threadId;
    }
    if (policy.lineage.parentThread === 'immediate_agent' && input.parentAgentId !== undefined) {
      headers['x-codex-parent-thread-id'] = input.snapshot.parentThreadId ?? input.parentAgentId;
    }
    if (policy.lineage.subagentMarker === 'enabled' && input.subagentKind !== undefined) {
      headers['x-openai-subagent'] = 'collab_spawn';
    }
    if (policy.responsesMetadata === 'codex' && policy.lineage.threadIdentity === 'agent') {
      headers['x-codex-window-id'] = requiredSnapshot(input.snapshot.windowId, 'window identity');
      if (input.snapshot.turnState !== undefined) {
        headers['x-codex-turn-state'] = input.snapshot.turnState;
      }
    }
  } else if (policy.lineage.format === 'grok_build') {
    if (policy.lineage.sessionScope !== 'none') {
      headers['x-grok-conv-id'] = sessionIdentity();
      headers['x-grok-session-id'] = sessionIdentity();
    }
    if (policy.request.logicalId === 'turn') {
      headers['x-grok-req-id'] = requiredSnapshot(input.snapshot.logicalId, 'logical request identity');
    }
    if (policy.request.turnIndex === 'agent_session') {
      headers['x-grok-turn-idx'] = String(requiredSnapshot(input.snapshot.turnIndex, 'turn index'));
    }
    if (policy.client.installationIdentity === 'persistent_local') {
      headers['x-grok-agent-id'] = requiredSnapshot(input.snapshot.installationId, 'installation identity');
    }
    headers['x-grok-client-identifier'] = 'grok-shell';
    headers['x-grok-client-version'] = input.runtimeVersion;
    headers['x-grok-model-override'] = input.model;
  } else if (policy.lineage.format === 'kimi_code' && input.isKimiProvider) {
    if (policy.client.installationIdentity === 'persistent_local') {
      Object.assign(headers, kimiCodeDeviceHeaders(input));
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
  } else if (policy.client.userAgent === 'kimi_code') {
    headers['User-Agent'] = `kimi-code-cli/${asciiHeader(input.runtimeVersion)}`;
  } else if (policy.client.userAgent === 'none') {
    headers[trueNone ? SUPPRESS_REQUEST_IDENTITY_HEADER : SUPPRESS_USER_AGENT_HEADER] = '1';
  }
  let responsesClientMetadata: Record<string, string> | undefined;
  if (policy.responsesMetadata === 'codex') {
    const canonical = codexTurnMetadata(input);
    const canonicalJson = JSON.stringify(canonical);
    responsesClientMetadata = { 'x-codex-turn-metadata': canonicalJson };
    if (policy.client.installationIdentity === 'persistent_local') {
      responsesClientMetadata['x-codex-installation-id'] = requiredSnapshot(
        input.snapshot.installationId,
        'installation identity',
      );
    }
    if (policy.lineage.sessionScope !== 'none') {
      responsesClientMetadata['session_id'] = sessionIdentity();
    }
    if (policy.lineage.threadIdentity === 'agent') {
      responsesClientMetadata['thread_id'] = requiredSnapshot(input.snapshot.threadId, 'thread identity');
      responsesClientMetadata['x-codex-window-id'] = requiredSnapshot(
        input.snapshot.windowId,
        'window identity',
      );
    }
    if (policy.request.logicalId === 'turn') {
      responsesClientMetadata['turn_id'] = requiredSnapshot(
        input.snapshot.logicalId,
        'logical request identity',
      );
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
    wire: {
      suppressUserAgent: policy.client.userAgent === 'none',
      suppressIdentity: trueNone,
      suppressMessagesMetadataUserId: true,
      responsesClientMetadata,
      onResponseHeaders:
        responsesClientMetadata === undefined
          ? undefined
          : (responseHeaders) => {
              const state = responseHeaders.get('x-codex-turn-state');
              if (state !== null && state.length > 0) input.snapshot.setTurnState(state);
            },
    },
  };
}

export function preflightRequestIdentityProjection(
  policy: ResolvedRequestIdentityPolicy,
  inputProtocol: Protocol,
): void {
  const protocol = protocolFamily(inputProtocol);
  if (policy.responsesMetadata === 'codex' && protocol !== 'responses') {
    throw unsupported('Codex-compatible request identity only supports OpenAI Responses');
  }
  if (policy.lineage.format === 'codex' && protocol !== 'responses') {
    throw unsupported('Codex-compatible request identity only supports OpenAI Responses');
  }
  if (policy.lineage.format === 'grok_build' && protocol === 'other') {
    throw unsupported('Grok Build-compatible request identity requires Responses or Messages');
  }
  if (policy.client.userAgent === 'none' && protocol === 'other') {
    throw unsupported('true none requires an adapter with a final fetch suppression seam');
  }
}

function codexTurnMetadata(input: Parameters<typeof projectRequestIdentity>[0]) {
  const policy = input.policy;
  const metadata: Record<string, string> = { request_kind: 'turn' };
  if (policy.client.installationIdentity === 'persistent_local') {
    metadata['installation_id'] = requiredSnapshot(
      input.snapshot.installationId,
      'installation identity',
    );
  }
  if (policy.lineage.sessionScope !== 'none') metadata['session_id'] = requestSessionIdentity(input);
  if (policy.lineage.threadIdentity === 'agent') {
    metadata['thread_id'] = requiredSnapshot(input.snapshot.threadId, 'thread identity');
    metadata['window_id'] = requiredSnapshot(input.snapshot.windowId, 'window identity');
  }
  if (policy.request.logicalId === 'turn') {
    metadata['turn_id'] = requiredSnapshot(input.snapshot.logicalId, 'logical request identity');
  }
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
  if (input.policy.lineage.sessionScope === 'agent_session') {
    return requiredSnapshot(input.snapshot.agentSessionId, 'agent-session identity');
  }
  if (input.policy.preset === 'kimi_code') return input.rawSessionId;
  return requiredSnapshot(input.snapshot.sharedSessionId, 'shared-session identity');
}

function kimiCodeDeviceHeaders(
  input: Parameters<typeof projectRequestIdentity>[0],
): Record<string, string> {
  return {
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': asciiHeader(input.runtimeVersion),
    'X-Msh-Device-Name': donorHeader(input, 'x-msh-device-name') ?? asciiHeader(hostname()),
    'X-Msh-Device-Model': donorHeader(input, 'x-msh-device-model') ?? asciiHeader(deviceModel()),
    'X-Msh-Os-Version': donorHeader(input, 'x-msh-os-version') ?? asciiHeader(release()),
    'X-Msh-Device-Id':
      donorHeader(input, 'x-msh-device-id') ??
      requiredSnapshot(input.snapshot.installationId, 'installation identity'),
  };
}

function donorHeader(
  input: Parameters<typeof projectRequestIdentity>[0],
  expectedName: string,
): string | undefined {
  for (const [name, value] of Object.entries(input.hostRequestHeaders ?? {})) {
    if (name.toLowerCase() !== expectedName) continue;
    const cleaned = asciiHeader(value);
    return cleaned === 'unknown' ? undefined : cleaned;
  }
  return undefined;
}

function deviceModel(): string {
  const type = osType();
  const version = release();
  const arch = hostArch();
  if (type === 'Windows_NT') return `Windows ${version} ${arch}`;
  return `${type} ${version} ${arch}`;
}

function asciiHeader(value: string): string {
  const cleaned = value.replaceAll(/[^\u0020-\u007E]/gu, '').trim();
  return cleaned.length > 0 ? cleaned : 'unknown';
}

function requiredSnapshot<T>(value: T | undefined, dimension: string): T {
  if (value === undefined) {
    throw new Error(`request identity ${dimension} was not allocated`);
  }
  return value;
}

function protocolFamily(protocol: Protocol): 'responses' | 'messages' | 'other' {
  if (protocol === 'openai_responses') return 'responses';
  if (protocol === 'anthropic') return 'messages';
  return 'other';
}

function unsupported(message: string): Error {
  return new Error2(RequestIdentityErrors.codes.REQUEST_IDENTITY_UNSUPPORTED, message);
}
