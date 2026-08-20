export type MainModelCandidateSource = 'input' | 'route' | 'profile' | 'default';

export interface MainModelCandidate {
  readonly alias: string | undefined;
  readonly source: MainModelCandidateSource;
}

export function resolveMainModelCandidate(input: {
  readonly inputModel?: string;
  readonly routeLockedAlias?: string;
  readonly profileModelAlias?: string;
  readonly defaultModel?: string;
}): MainModelCandidate {
  const inputModel = nonempty(input.inputModel);
  if (inputModel !== undefined) return { alias: inputModel, source: 'input' };
  const routeLockedAlias = nonempty(input.routeLockedAlias);
  if (routeLockedAlias !== undefined) return { alias: routeLockedAlias, source: 'route' };
  const profileModelAlias = nonempty(input.profileModelAlias);
  if (profileModelAlias !== undefined) return { alias: profileModelAlias, source: 'profile' };
  return { alias: nonempty(input.defaultModel), source: 'default' };
}

export function resolveMainThinkingCandidate(input: {
  readonly inputThinking?: string;
  readonly routeLockedThinking?: string;
  readonly modelProfileThinking?: string;
  readonly profileThinking?: string;
  readonly sessionThinking?: string;
}): string | undefined {
  return (
    nonempty(input.inputThinking) ??
    nonempty(input.routeLockedThinking) ??
    nonempty(input.modelProfileThinking) ??
    nonempty(input.profileThinking) ??
    nonempty(input.sessionThinking)
  );
}

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
