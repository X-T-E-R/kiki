import {
  analyzeDangerousBash,
  DANGEROUS_BASH_PARSE_OPTIONS,
} from '#/agent/permission/dangerousBash/analyzeDangerousBash';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { isDangerousBashGuardEnabled } from '#/agent/permissionRules/configSection';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IConfigService } from '#/app/config/config';
import type { PermissionPolicyEvaluation } from '../permissionPolicy';

export class DangerousBashPermissionPolicyService implements PermissionPolicy {
  readonly name = 'dangerous-bash';

  constructor(
    @IBashParserService private readonly bashParser: IBashParserService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (!isDangerousBashGuardEnabled(this.config, this.modeService.mode)) return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    if (command === undefined) return undefined;
    const verdict = analyzeDangerousBash(command, (source) =>
      this.bashParser.parse(source, DANGEROUS_BASH_PARSE_OPTIONS),
    );
    if (verdict?.kind !== 'dangerous') return undefined;
    return { kind: 'ask', reason: { dangerous_command: verdict.command } };
  }

  upgradeApprove(
    evaluation: PermissionPolicyEvaluation,
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyEvaluation {
    if (evaluation.result.kind !== 'approve') return evaluation;
    const result = this.evaluate(context);
    return result === undefined ? evaluation : { policyName: this.name, result };
  }
}

function bashCommandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}
