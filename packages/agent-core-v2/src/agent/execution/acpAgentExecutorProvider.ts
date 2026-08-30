import { z } from 'zod';

import {
  type AgentExecutorOptions,
  type AgentExecutorProvider,
  registerAgentExecutorProvider,
} from '#/app/agentExecutor/agentExecutor';

import { AcpAgentExecutorSession } from './acpAgentExecutorSession';

const acpExecutorOptionsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export const AcpAgentExecutorProvider: AgentExecutorProvider = {
  id: 'acp-process',
  protocol: 'acp-v1',
  validateOptions(value: unknown): AgentExecutorOptions {
    return acpExecutorOptionsSchema.parse(value ?? {});
  },
  create(context) {
    return new AcpAgentExecutorSession(context);
  },
};

registerAgentExecutorProvider(AcpAgentExecutorProvider);
