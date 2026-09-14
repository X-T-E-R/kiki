import {
  mergeResolvedPromptOverrides,
  resolvePromptOverrideLayer,
  type PromptOverrideSurface,
  type ResolvedPromptOverrides,
} from '@kiki/agent-profiles/promptOverrides';
import { join } from 'pathe';

import type { CollectionView } from '#/_base/di/collection';
import { BugIndicatingError, Error2 } from '#/_base/errors/errors';
import { CoreErrors } from '#/_base/errors/codes';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';

import './builtinPromptFields';
import {
  getPromptFieldContributions,
  PromptFieldContribution,
  type PromptFieldContribution as PromptFieldContributionRecord,
} from './promptFieldContribution';
import { readPromptOverrideFile } from './promptOverrideFile';
import {
  IPromptFieldRegistry,
  type PromptFieldContext,
  type PromptFieldDefinition,
  type PromptFieldApplicability,
  type PromptOverrideResolutionInput,
  type PromptOverrideScopeInput,
  type ResolvedPromptFieldOverrides,
} from './promptFieldRegistry';

const FIELD_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_FIELD_VARIABLES = new Set([
  'base_prompt',
  'parent_prompt',
  'builtin_prompt',
  '__proto__',
  'constructor',
  'prototype',
]);

export class PromptFieldRegistryService extends Disposable implements IPromptFieldRegistry {
  declare readonly _serviceBrand: undefined;

  private definitions = new Map<string, PromptFieldDefinition>();
  private readonly watchedFiles = new Set<string>();
  private readonly onDidChangeEmitter = this._register(new Emitter<{ readonly ref?: string }>());
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    @PromptFieldContribution private readonly view: CollectionView<PromptFieldContributionRecord>,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    this.refold();
    this._register(this.view.onDidChange(() => {
      this.refold();
      this.onDidChangeEmitter.fire({});
    }));
  }

  list(): readonly PromptFieldDefinition[] {
    return [...this.definitions.values()];
  }

  get(id: string): PromptFieldDefinition | undefined {
    return this.definitions.get(id);
  }

  validate(
    overrides: ResolvedPromptOverrides,
    context: PromptFieldContext = {},
    customVariables: Readonly<Record<string, string>> = {},
  ): ResolvedPromptFieldOverrides {
    const fields = Object.entries(overrides.values).map(([id, value]) => {
      const definition = this.definitions.get(id);
      if (definition === undefined) {
        throw invalidOverride(`Unknown prompt field "${id}"`, { id });
      }
      if (definition.readonly) {
        throw invalidOverride(`Prompt field "${id}" is readonly`, { id });
      }
      if (value.length === 0 && !definition.allowEmpty) {
        throw invalidOverride(`Prompt field "${id}" does not allow an empty override`, { id });
      }
      validateTemplate(definition, value, customVariables);
      return {
        id,
        value,
        status: applies(definition.appliesTo, context) ? 'effective' as const : 'inactive' as const,
        sources: overrides.sources[id] ?? [],
      };
    });
    return {
      values: Object.fromEntries(fields.filter((field) => field.status === 'effective').map((field) => [field.id, field.value])),
      fields,
    };
  }

  async resolve(input: PromptOverrideResolutionInput): Promise<ResolvedPromptFieldOverrides> {
    assertSurface(input.global, ['global']);
    assertSurface(input.model, ['model']);
    assertSurface(input.profile, ['profile', 'system']);
    assertSurface(input.profileModel, ['profile-model']);
    const layers = [];
    for (const scope of [input.global, input.model, input.profile, input.profileModel]) {
      const layer = await this.resolveScope(scope);
      if (layer !== undefined) layers.push(layer);
    }
    return this.validate(
      mergeResolvedPromptOverrides(...layers),
      input.context,
      input.customVariables,
    );
  }

  private async resolveScope(scope: PromptOverrideScopeInput | undefined): Promise<ResolvedPromptOverrides | undefined> {
    if (scope?.overrides === undefined) return undefined;
    const declarations = Array.isArray(scope.overrides) ? scope.overrides : [scope.overrides];
    const layers = [];
    for (const declaration of declarations) {
      const files = [];
      for (const ref of declaration.files ?? []) {
        files.push(await readPromptOverrideFile(
          this.fs,
          this.bootstrap.homeDir,
          ref,
          this.bootstrap.platform === 'win32' ? 'win32' : 'posix',
        ));
        this.watchFile(ref);
      }
      layers.push(resolvePromptOverrideLayer({
        surface: scope.surface,
        files,
        inline: declaration.fields,
        fieldPolicy: (id) => {
          const definition = this.definitions.get(id);
          return definition === undefined ? undefined : { allowEmpty: definition.allowEmpty };
        },
        inlinePath: scope.sourcePath,
      }));
    }
    return mergeResolvedPromptOverrides(...layers);
  }

  private watchFile(ref: string): void {
    if (this.watchedFiles.has(ref)) return;
    this.watchedFiles.add(ref);
    const watch = this._register(this.fsWatch.watch(join(this.bootstrap.homeDir, ref)));
    this._register(watch.onDidChange(() => this.onDidChangeEmitter.fire({ ref })));
  }

  private refold(): void {
    const next = new Map<string, PromptFieldDefinition>();
    for (const contribution of [
      ...getPromptFieldContributions(),
      ...this.view.items,
    ]) {
      validateDefinition(contribution.definition);
      if (next.has(contribution.definition.id)) {
        throw new BugIndicatingError(`Prompt field "${contribution.definition.id}" is registered more than once`);
      }
      next.set(contribution.definition.id, contribution.definition);
    }
    this.definitions = next;
  }
}

function validateDefinition(definition: PromptFieldDefinition): void {
  if (!FIELD_ID_PATTERN.test(definition.id)) {
    throw new BugIndicatingError(`Invalid prompt field id "${definition.id}"`);
  }
  if (definition.owner.trim() === '' || (definition.defaultTemplate.kind === 'resource' && definition.defaultTemplate.value.trim() === '')) {
    throw new BugIndicatingError(`Prompt field "${definition.id}" has an invalid owner or default template reference`);
  }
  if (!Number.isSafeInteger(definition.contractVersion) || definition.contractVersion < 1) {
    throw new BugIndicatingError(`Prompt field "${definition.id}" has an invalid contract version`);
  }
  for (const name of [...definition.allowedVariables, ...definition.requiredPlaceholders]) {
    if (!VARIABLE_PATTERN.test(name) || FORBIDDEN_FIELD_VARIABLES.has(name)) {
      throw new BugIndicatingError(`Prompt field "${definition.id}" declares invalid variable "${name}"`);
    }
  }
  for (const name of definition.requiredPlaceholders) {
    if (!definition.allowedVariables.includes(name)) {
      throw new BugIndicatingError(`Prompt field "${definition.id}" requires undeclared placeholder "${name}"`);
    }
  }
}

function validateTemplate(
  definition: PromptFieldDefinition,
  value: string,
  customVariables: Readonly<Record<string, string>>,
): void {
  const seen = new Set<string>();
  if (value.replaceAll(/\$\{[^}]*\}/g, '').includes('${')) {
    throw invalidOverride(`Prompt field "${definition.id}" contains an invalid variable expression`, { id: definition.id });
  }
  for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
    const name = match[1] ?? '';
    if (!VARIABLE_PATTERN.test(name)) {
      throw invalidOverride(`Prompt field "${definition.id}" contains an invalid variable expression`, { id: definition.id });
    }
    if (FORBIDDEN_FIELD_VARIABLES.has(name)) {
      throw invalidOverride(`Prompt field "${definition.id}" uses reserved variable "${name}"`, { id: definition.id, variable: name });
    }
    if (!definition.allowedVariables.includes(name) && !Object.hasOwn(customVariables, name)) {
      throw invalidOverride(`Prompt field "${definition.id}" uses unknown variable "${name}"`, { id: definition.id, variable: name });
    }
    seen.add(name);
  }
  for (const required of definition.requiredPlaceholders) {
    if (!seen.has(required)) {
      throw invalidOverride(`Prompt field "${definition.id}" must retain placeholder "${required}"`, { id: definition.id, variable: required });
    }
  }
}

function applies(condition: PromptFieldApplicability | undefined, context: PromptFieldContext): boolean {
  if (condition === undefined) return true;
  return matches(condition.profiles, context.profileName)
    && matches(condition.models, context.modelAlias)
    && matches(condition.executors, context.executor)
    && matches(condition.consumers, context.consumer)
    && matches(condition.delegationPositions, context.delegationPosition);
}

function matches(allowed: readonly string[] | undefined, actual: string | undefined): boolean {
  return allowed === undefined || (actual !== undefined && allowed.includes(actual));
}

function assertSurface(
  scope: PromptOverrideScopeInput | undefined,
  allowed: readonly PromptOverrideSurface[],
): void {
  if (scope !== undefined && !allowed.includes(scope.surface)) {
    throw invalidOverride(`Prompt override surface "${scope.surface}" is not valid in this scope`, { surface: scope.surface });
  }
}

function invalidOverride(message: string, details: Readonly<Record<string, unknown>>): Error2 {
  return new Error2(CoreErrors.codes.VALIDATION_FAILED, message, {
    details,
    name: 'PromptFieldValidationError',
  });
}

registerScopedService(
  LifecycleScope.App,
  IPromptFieldRegistry,
  PromptFieldRegistryService,
  ScopeActivation.OnScopeCreated,
  'promptField',
);
