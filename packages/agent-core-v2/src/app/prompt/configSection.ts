import { PromptConfigSchema, type PromptConfig } from '@kiki/agent-profiles/promptConfig';

import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ConfigWriteValidatorContribution } from '#/app/config/configWriteValidation';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { IPromptFieldRegistry } from '#/app/promptField/promptFieldRegistry';
import { LifecycleScope } from '#/app/scopes';

export { PromptConfigSchema, PromptConfigPatchSchema, type PromptConfig } from '@kiki/agent-profiles/promptConfig';
export { PromptOverridesSchema, type PromptOverrides } from '@kiki/agent-profiles/promptOverrides';
export const PROMPT_SECTION = 'prompt';

registerConfigSection(PROMPT_SECTION, PromptConfigSchema, {
  defaultValue: {},
  fromToml: (value) => value,
  toToml: (value) => value,
});

interface IPromptConfigWriteValidator {
  readonly _serviceBrand: undefined;
}

const IPromptConfigWriteValidator = createDecorator<IPromptConfigWriteValidator>('promptConfigWriteValidator');

class PromptConfigWriteValidator extends Service implements IPromptConfigWriteValidator {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IPromptFieldRegistry fields: IPromptFieldRegistry,
  ) {
    super();
    this.provide(ConfigWriteValidatorContribution, {
      domain: PROMPT_SECTION,
      validate: (value) => {
        const config: PromptConfig = PromptConfigSchema.parse(value);
        fields.validate(
          { values: config.overrides?.fields ?? {}, sources: {} },
          {},
          config.variables,
        );
      },
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IPromptConfigWriteValidator,
  PromptConfigWriteValidator,
  ScopeActivation.OnScopeCreated,
  'prompt',
);
