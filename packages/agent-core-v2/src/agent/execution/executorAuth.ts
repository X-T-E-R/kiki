import { AcpClientError, AcpClientErrorCode } from '@kiki/acp-client';
import type { CodexNotification } from '@kiki/codex-client';
import type { ExecutorAuthObservation } from '@kiki/protocol';

import { agentExecutorBindingFingerprint, type AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ExecutorAuthObserved } from './externalExecutorOps';

type AuthFact = Pick<ExecutorAuthObservation, 'status' | 'source' | 'scope'>;

export function acpAuthObservation(error: unknown): AuthFact | undefined {
  return error instanceof AcpClientError && error.code === AcpClientErrorCode.AuthenticationRequired
    ? { status: 'required', source: 'acp.authentication_required', scope: 'session' }
    : undefined;
}

export function codexAuthObservation(notification: CodexNotification): AuthFact | undefined {
  if (notification.method !== 'account/updated') return undefined;
  const params = notification.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params) || !('authMode' in params)) return undefined;
  const mode = params.authMode;
  const known = ['apikey', 'chatgpt', 'chatgptAuthTokens', 'headers', 'agentIdentity', 'personalAccessToken', 'bedrockApiKey', 'bedrockAccessKeys'];
  return { status: mode === null ? 'logged_out' : typeof mode === 'string' && known.includes(mode) ? 'logged_in' : 'unknown',
    source: 'codex.account.updated', scope: 'vendor_account' };
}

export async function recordExecutorAuth(context: AgentExecutorContext, cwd: string, fact: AuthFact): Promise<void> {
  const observation: ExecutorAuthObservation = {
    ...fact,
    executor_id: context.descriptor.id,
    descriptor_revision: context.descriptor.revision,
    binding_fingerprint: agentExecutorBindingFingerprint(context.binding),
    execution_generation: context.binding.execution?.generation,
    cwd,
    home_dir: context.descriptor.homeDir,
    selected_source: context.descriptor.selectedSource,
    observed_at: Date.now(),
  };
  await context.agent.accessor.get(IEventDispatcher).dispatch(new ExecutorAuthObserved(observation));
  await context.agent.accessor.get(ISessionMetadata).updateAgent(context.agent.id, (current) => ({
    ...current, executorAuth: observation,
  }));
}
