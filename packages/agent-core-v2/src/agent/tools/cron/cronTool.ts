import { z } from 'zod';
import CRON_DESCRIPTION from './cron.md?raw';

import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { ICronCreateTool, CronCreateInputSchema } from './cron-create/cron-create';
import { ICronListTool } from './cron-list/cron-list';
import { ICronDeleteTool, CronDeleteInputSchema } from './cron-delete/cron-delete';

const CronInputSchema = z.discriminatedUnion('action', [
  CronCreateInputSchema.extend({ action: z.literal('create') }),
  z.object({ action: z.literal('list') }).strict(),
  CronDeleteInputSchema.extend({ action: z.literal('delete') }),
]);

type CronInput = z.infer<typeof CronInputSchema>;

export interface ICronTool extends AgentTool<CronInput> {}
export const ICronTool = createDecorator<ICronTool>('cronTool');

export class CronTool implements ICronTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Cron';
  readonly description = CRON_DESCRIPTION;
  readonly parameters = toInputJsonSchema(CronInputSchema);

  constructor(
    @ICronCreateTool private readonly create: ICronCreateTool,
    @ICronListTool private readonly list: ICronListTool,
    @ICronDeleteTool private readonly remove: ICronDeleteTool,
    @IAgentToolPolicyService private readonly policy: IAgentToolPolicyService,
  ) {}

  async resolveExecution(input: CronInput): Promise<ToolExecution> {
    const parsed = CronInputSchema.safeParse(input);
    if (!parsed.success) return { isError: true, output: parsed.error.message };
    const action = parsed.data.action;
    const oldName = action === 'create' ? 'CronCreate' : action === 'list' ? 'CronList' : 'CronDelete';
    if (!this.policy.isToolActive(oldName)) {
      return { isError: true, output: `Cron action ${action} is disabled by the active tool policy.` };
    }
    const execution = await (action === 'create' ? this.create.resolveExecution(parsed.data)
      : action === 'list' ? this.list.resolveExecution({}) : this.remove.resolveExecution(parsed.data));
    if ('isError' in execution && execution.isError === true) return execution;
    return { ...execution, matchesRule: (rule) =>
      rule === action || execution.matchesRule?.(rule) === true };
  }
}

registerScopedService(LifecycleScope.Agent, ICronTool, CronTool, ScopeActivation.OnScopeCreated, 'cron');
