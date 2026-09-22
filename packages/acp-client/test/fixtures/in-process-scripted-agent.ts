import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentCapabilities,
  type PermissionOption,
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
  readonly stopReason?: StopReason;
  readonly hangPrompt?: boolean;
}

export interface InProcessAgentHistory {
  readonly methods: string[];
  readonly configValues: Array<{ configId: string; value: string | boolean }>;
  readonly permissionResponses: unknown[];
  readonly initializeParams: unknown[];
  readonly sessionNewParams: unknown[];
  readonly sessionResumeParams: unknown[];
  readonly sessionLoadParams: unknown[];
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
      };
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      history.methods.push('session/new');
      history.sessionNewParams.push(params);
      return { sessionId, configOptions };
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
      return { configOptions };
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      history.methods.push('session/set_config_option');
      history.configValues.push({ configId: params.configId, value: params.value });
      return { configOptions };
    })
    .onRequest(methods.agent.session.setMode, () => {
      history.methods.push('session/set_mode');
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ client }) => {
      history.methods.push('session/prompt');
      for (const update of script.promptUpdates ?? []) {
        await client.notify(methods.client.session.update as string, {
          sessionId,
          update,
        });
      }
      if (script.permissionOptions !== undefined) {
        const response = await client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
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
    .onNotification(methods.agent.session.cancel, () => {
      history.cancelCount += 1;
      settlePrompt?.('cancelled');
      settlePrompt = undefined;
    });

  return { app, history };
}
