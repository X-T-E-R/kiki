# Feature flags

`IFlagService` resolves distributed domain definitions at App scope, with overrides in `[experimental]`. Product features, including new features, are available by default. Keep a flag only for a real rollout or rollback boundary; ordinary configured features do not need another experimental master gate. A default-off definition requires an explicit human requirement and its source.

Availability preserves user off choices and does not authorize external connections, plugin installation, or script execution. Consent, per-destination enablement and permission checks remain in their owning domains.

## Definitions and resolution

The runtime registry is distributed, not a central array. Each owning domain calls `registerFlagDefinition` at import time; `FlagRegistryService` drains those contributions when instantiated. `IFlagRegistry.register` also accepts runtime contributions and returns a disposable that unregisters them.

The implementation lives in `src/app/flag/`: `flagRegistry.ts` owns the definition contract and contribution queue, `flagRegistryService.ts` owns the catalog, `flag.ts` registers the experimental config section, and `flagService.ts` resolves it. The package entry imports leaf modules precisely; there is no domain barrel to add.

Highest precedence wins:

1. The definition's per-feature environment variable, including explicit false.
2. The per-flag `[experimental]` config value, including explicit false.
3. Truthy `KIKI_EXPERIMENTAL_FLAG`.
4. The registry default.

A falsy master environment variable is unset, not a global off command. Environment variables are read live. The service refreshes config overrides on `onDidChangeConfiguration` for the experimental domain; consumers that capture the result during construction may require a restart.

`enabled(id)` returns false for an unregistered id. `explain(id)` returns undefined for it; registered states include the effective value, source and saved config value. `snapshot`, `enabledIds` and `explainAll` enumerate the effective registry. Loose boolean config keys preserve obsolete values as inert configuration without recreating retired features.

## Add or retain a flag

Use the owning domain's `flag.ts` and import its leaf from `src/index.ts` before any consumer resolves `IFlagService`:

```ts
import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const myFeatureFlag: FlagDefinitionInput = {
  id: 'my_feature',
  title: 'My feature',
  description: 'The capability this switch controls.',
  env: 'KIKI_EXPERIMENTAL_MY_FEATURE',
  default: true,
  surface: 'both',
};

registerFlagDefinition(myFeatureFlag);
```

The environment name must be unique, start with `KIKI_EXPERIMENTAL_`, and not equal `KIKI_EXPERIMENTAL_FLAG`. The id must not be `flag`; duplicate ids fail registration. `FlagId` remains a string, and `surface` (`core`, `tui`, `both`) is descriptive metadata, not a resolution rule.

Every built-in id also needs a home in `EXPERIMENTAL_FLAG_HOMES` (`packages/session-core/src/settings/settings.ts`), its actual Settings page and application timing, and a name and description in both `src/i18n/en.ts` and `zh.ts`. The distributed-registration regression in `src/settings/settings.test.ts` checks this coverage and defaults. Unknown-server copy is for extensions, not missing built-in entries.

Inject `IFlagService` to consume a retained boundary. Tests resolve the service through DI with an injected environment map and real config/registry services, checking the omitted/default path and explicit false. See `test/app/flag/flag.test.ts` and the lifecycle guidance in `.agents/skills/agent-core-dev/flags.md`.
