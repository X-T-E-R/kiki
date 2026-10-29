import {
  agent,
  methods,
  ndJsonStream,
  RequestError,
  type AgentApp,
  type AgentCapabilities,
  type PermissionOption,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type StopReason,
} from '@agentclientprotocol/sdk';

export type ScriptedOpenBehavior = 'ok' | 'method_not_found' | 'unknown_session';

export interface InProcessAgentScript {
  readonly capabilities?: AgentCapabilities;
  readonly sessionId?: string;
  readonly resume?: ScriptedOpenBehavior;
  readonly load?: ScriptedOpenBehavior;
  readonly loadReplay?: readonly unknown[];
  readonly promptUpdates?: readonly unknown[];
  readonly permissionOptions?: readonly PermissionOption[];
  readonly permissionToolCall?: RequestPermissionRequest['toolCall'];
  readonly permissionSessionId?: string;
  readonly stopReason?: StopReason;
  readonly hangPrompt?: boolean;
  readonly modeUpdate?: string;
  readonly modeConfigUpdate?: { readonly value: string; readonly sessionId?: string };
  readonly sessionResponseMeta?: Record<string, unknown>;
  readonly initializeMeta?: Record<string, unknown>;
  readonly steeringOutcome?: 'injected' | 'promptRequired' | 'startedNewTurn' | 'deliveryUnknown' | 'unknown' | 'reject' | 'abort' | 'hang';
}

export interface InProcessAgentHistory {
  readonly methods: string[];
  readonly configValues: Array<{ configId: string; value: string | boolean }>;
  readonly permissionResponses: unknown[];
  readonly initializeParams: unknown[];
  readonly sessionNewParams: unknown[];
  readonly sessionResumeParams: unknown[];
  readonly sessionLoadParams: unknown[];
  readonly sessionForkParams: unknown[];
  readonly promptParams: unknown[];
  readonly steeringParams: unknown[];
  cancelCount: number;
}

const configOptions: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'model-a',
    options: [
      { value: 'model-a', name: 'Model A' },
      { value: 'model-b', name: 'Model B' },
    ],
  },
  {
    id: 'thought',
    name: 'Thought level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
];

function openFailure(method: string, behavior: ScriptedOpenBehavior | undefined): void {
  if (behavior === 'method_not_found') throw RequestError.methodNotFound(method);
  if (behavior === 'unknown_session') throw RequestError.resourceNotFound('session://unknown');
}

export function createInProcessScriptedAgent(
  script: InProcessAgentScript = {},
): { readonly app: AgentApp; readonly history: InProcessAgentHistory } {
  const sessionId = script.sessionId ?? 'session-in-process';
  const history: InProcessAgentHistory = {
    methods: [],
    configValues: [],
    permissionResponses: [],
    initializeParams: [],
    sessionNewParams: [],
    sessionResumeParams: [],
    sessionLoadParams: [],
    sessionForkParams: [],
    promptParams: [],
    steeringParams: [],
    cancelCount: 0,
  };
  let settlePrompt: ((stopReason: StopReason) => void) | undefined;

  const app = agent({ name: 'in-process-scripted-agent' })
    .onRequest(methods.agent.initialize, ({ params }) => {
      history.methods.push('initialize');
      history.initializeParams.push(params);
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: script.capabilities ?? {
          loadSession: true,
          sessionCapabilities: { resume: {} },
        },
        agentInfo: { name: 'scripted-agent', version: '1.0.0' },
        ...(script.initializeMeta === undefined ? {} : { _meta: script.initializeMeta }),
      };
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      history.methods.push('session/new');
      history.sessionNewParams.push(params);
      return { sessionId, configOptions, _meta: script.sessionResponseMeta };
    })
    .onRequest(methods.agent.session.fork, ({ params }) => {
      history.methods.push('session/fork');
      history.sessionForkParams.push(params);
      return { sessionId: 'forked-session', configOptions };
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      history.methods.push('session/resume');
      history.sessionResumeParams.push(params);
      openFailure('session/resume', script.resume);
      return { configOptions };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      history.methods.push('session/load');
      history.sessionLoadParams.push(params);
      openFailure('session/load', script.load);
      for (const update of script.loadReplay ?? []) {
        await client.notify(methods.client.session.update as string, {
          sessionId,
          update,
        });
      }
      return { configOptions, _meta: script.sessionResponseMeta };
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      history.methods.push('session/set_config_option');
      history.configValues.push({ configId: params.configId, value: params.value });
      return { configOptions };
    })
    .onRequest(methods.agent.session.setMode, async ({ client }) => {
      history.methods.push('session/set_mode');
      if (script.modeUpdate !== undefined) {
        await client.notify(methods.client.session.update as string, {
          sessionId,
          update: { sessionUpdate: 'current_mode_update', currentModeId: script.modeUpdate },
        });
      }
      if (script.modeConfigUpdate !== undefined) {
        await client.notify(methods.client.session.update as string, {
          sessionId: script.modeConfigUpdate.sessionId ?? sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: [...configOptions, {
            id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: script.modeConfigUpdate.value,
            options: [{ value: 'manual', name: 'Manual' }, { value: 'auto', name: 'Auto' }],
          }] },
        });
      }
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
      history.methods.push('session/prompt');
      history.promptParams.push(params);
      for (const update of script.promptUpdates ?? []) {
        await client.notify(methods.client.session.update as string, {
          sessionId,
          update,
        });
      }
      if (script.permissionOptions !== undefined) {
        const response = await client.request(methods.client.session.requestPermission, {
          sessionId: script.permissionSessionId ?? sessionId,
          toolCall: script.permissionToolCall ?? {
            toolCallId: 'tool-1',
            title: 'Scripted tool',
            status: 'pending',
          },
          options: [...script.permissionOptions],
        });
        history.permissionResponses.push(response);
      }
      if (script.hangPrompt === true) {
        const stopReason = await new Promise<StopReason>((resolve) => {
          settlePrompt = resolve;
        });
        return { stopReason };
      }
      return { stopReason: script.stopReason ?? 'end_turn' };
    })
    .onRequest('_session/steering', (params: unknown) => params, async ({ params }) => {
      history.methods.push('_session/steering');
      history.steeringParams.push(params);
      if (script.steeringOutcome === 'reject') throw RequestError.methodNotFound('_session/steering');
      if (script.steeringOutcome === 'abort') {
        const error = new Error('steering aborted');
        error.name = 'AbortError';
        throw error;
      }
      if (script.steeringOutcome === 'hang') await new Promise<void>(() => undefined);
      return { outcome: script.steeringOutcome ?? 'injected' };
    })
    .onNotification(methods.agent.session.cancel, () => {
      history.cancelCount += 1;
      settlePrompt?.('cancelled');
      settlePrompt = undefined;
    });

  return { app, history };
}

export function connectInProcessScriptedAgent(
  app: AgentApp,
  ...streams: Parameters<typeof ndJsonStream>
): void {
  app.connect(ndJsonStream(...streams));
}
