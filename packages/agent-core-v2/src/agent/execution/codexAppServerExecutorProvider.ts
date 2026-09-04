import { z } from 'zod';

import {
  type AgentExecutorOptions,
  type AgentExecutorProvider,
  registerAgentExecutorProvider,
} from '#/app/agentExecutor/agentExecutor';

import { CodexAppServerExecutorSession } from './codexAppServerExecutorSession';

const codexExecutorOptionsSchema = z.object({}).strict();

export const CodexAppServerExecutorProvider: AgentExecutorProvider = {
  id: 'codex-app-server-process',
  protocol: 'codex-app-server',
  validateOptions(value: unknown): AgentExecutorOptions {
    return codexExecutorOptionsSchema.parse(value ?? {});
  },
  validateBinding(binding) {
    return { ok: true, binding };
  },
  create(context) {
    return new CodexAppServerExecutorSession(context);
  },
};

registerAgentExecutorProvider(CodexAppServerExecutorProvider);
