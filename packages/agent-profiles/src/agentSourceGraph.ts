import { dirname, isAbsolute, relative, resolve } from 'pathe';

import { AgentFileParseError, parseAgentFileText } from './agentFile';
import type { AgentFileDefinition, AgentFileScopedBinding } from './agentFileTypes';
import type { HostFs } from './hostFs';
import {
  AgentProfileSourceDiagnosticCodes,
  type AgentProfileDiagnostic,
} from './scopedAgentProfile';
import { isSourceSubagentLease } from './subagentLease';

const MAX_SOURCE_DEPTH = 8;

export interface AgentSourceGraphResult {
  readonly scopedBindings: ReadonlyMap<string, ReadonlyMap<string, AgentFileScopedBinding>>;
  readonly sourceDefinitions: ReadonlyMap<string, AgentFileDefinition>;
  readonly dependencyIndex: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly AgentProfileDiagnostic[];
}

export function agentProfileDefinitionId(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return process.platform === 'win32' || /^[a-zA-Z]:\//u.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

export async function resolveAgentSourceGraph(
  fs: HostFs,
  parents: readonly AgentFileDefinition[],
  warn?: (message: string, error?: unknown) => void,
): Promise<AgentSourceGraphResult> {
  const bindings = new Map<string, Map<string, AgentFileScopedBinding>>();
  const definitions = new Map<string, AgentFileDefinition>();
  const dependencies = new Map<string, Set<string>>();
  const diagnostics: AgentProfileDiagnostic[] = [];

  const recordDiagnostic = (diagnostic: AgentProfileDiagnostic, error?: unknown): void => {
    diagnostics.push(diagnostic);
    warn?.(diagnostic.message, error);
  };

  const unavailable = (
    parent: AgentFileDefinition,
    alias: string,
    source: string,
    lease: Extract<NonNullable<AgentFileDefinition['subagentLeases']>[string], { source: string }>,
    diagnostic: AgentProfileDiagnostic,
    error?: unknown,
  ): AgentFileScopedBinding => {
    recordDiagnostic(diagnostic, error);
    return {
      parentDefinitionId: parent.definitionId,
      alias,
      source,
      lease,
      status: 'unavailable',
      diagnostic,
    };
  };

  const resolveParent = async (
    parent: AgentFileDefinition,
    depth: number,
    stack: readonly string[],
  ): Promise<void> => {
    const table = bindings.get(parent.definitionId) ?? new Map<string, AgentFileScopedBinding>();
    bindings.set(parent.definitionId, table);
    for (const lease of Object.values(parent.subagentLeases ?? {})) {
      if (!isSourceSubagentLease(lease)) continue;
      const alias = lease.name;
      const source = lease.source;
      const lexicalPath = resolve(dirname(parent.path), source);
      if (!isWithin(parent.contributionRoot, lexicalPath)) {
        const diagnostic = sourceDiagnostic(
          AgentProfileSourceDiagnosticCodes.PATH_ESCAPE,
          parent,
          alias,
          source,
          `Scoped source "${source}" for "${alias}" in ${parent.path} escapes contribution root ${parent.contributionRoot}`,
          lexicalPath,
        );
        table.set(alias, unavailable(parent, alias, source, lease, diagnostic));
        continue;
      }
      if (depth + 1 > MAX_SOURCE_DEPTH) {
        const diagnostic = sourceDiagnostic(
          AgentProfileSourceDiagnosticCodes.DEPTH_EXCEEDED,
          parent,
          alias,
          source,
          `Scoped source graph from ${parent.path} exceeds maximum depth ${MAX_SOURCE_DEPTH} at "${alias}"`,
          lexicalPath,
        );
        table.set(alias, unavailable(parent, alias, source, lease, diagnostic));
        continue;
      }

      let canonicalPath: string;
      try {
        canonicalPath = (await fs.realpath(lexicalPath)).replaceAll('\\', '/');
      } catch (error) {
        const diagnostic = sourceDiagnostic(
          AgentProfileSourceDiagnosticCodes.UNAVAILABLE,
          parent,
          alias,
          source,
          `Scoped source "${source}" for "${alias}" in ${parent.path} is unavailable`,
          lexicalPath,
        );
        table.set(alias, unavailable(parent, alias, source, lease, diagnostic, error));
        continue;
      }
      const canonicalRoot = parent.contributionRoot;
      if (!isWithin(canonicalRoot, canonicalPath)) {
        const diagnostic = sourceDiagnostic(
          AgentProfileSourceDiagnosticCodes.SYMLINK_ESCAPE,
          parent,
          alias,
          source,
          `Scoped source "${source}" for "${alias}" in ${parent.path} resolves outside contribution root through a symbolic link`,
          lexicalPath,
        );
        table.set(alias, unavailable(parent, alias, source, lease, diagnostic));
        continue;
      }

      const definitionId = agentProfileDefinitionId(canonicalPath);
      const dependencyParents = dependencies.get(definitionId) ?? new Set<string>();
      dependencyParents.add(parent.definitionId);
      dependencies.set(definitionId, dependencyParents);
      if (stack.includes(definitionId)) {
        const chain = [...stack, definitionId].join(' -> ');
        const diagnostic = sourceDiagnostic(
          AgentProfileSourceDiagnosticCodes.CYCLE,
          parent,
          alias,
          source,
          `Scoped source cycle detected: ${chain}`,
          canonicalPath,
        );
        table.set(alias, unavailable(parent, alias, source, lease, diagnostic));
        continue;
      }

      let definition = definitions.get(definitionId);
      if (definition === undefined) {
        try {
          definition = parseAgentFileText({
            path: canonicalPath,
            source: parent.source,
            text: await fs.readFile(canonicalPath),
            definitionId,
            contributionRoot: canonicalRoot,
            sourceProfile: true,
            warn: (message) => warn?.(message),
          });
        } catch (error) {
          const message =
            error instanceof AgentFileParseError
              ? error.message
              : `Unexpected error while parsing scoped source ${canonicalPath}`;
          const diagnostic = sourceDiagnostic(
            AgentProfileSourceDiagnosticCodes.INVALID_PROFILE,
            parent,
            alias,
            source,
            message,
            canonicalPath,
          );
          table.set(alias, unavailable(parent, alias, source, lease, diagnostic, error));
          continue;
        }
        if (!definition.private && !hasPrivatePathSegment(canonicalRoot, canonicalPath)) {
          const diagnostic = sourceDiagnostic(
            AgentProfileSourceDiagnosticCodes.NOT_PRIVATE,
            parent,
            alias,
            source,
            `Scoped source ${canonicalPath} must declare "private: true" or be located under an _private directory`,
            canonicalPath,
          );
          table.set(alias, unavailable(parent, alias, source, lease, diagnostic));
          continue;
        }
        definitions.set(definitionId, definition);
      }

      table.set(alias, {
        parentDefinitionId: parent.definitionId,
        alias,
        source,
        lease,
        status: 'ready',
        sourceDefinitionId: definitionId,
        definition,
      });
      await resolveParent(definition, depth + 1, [...stack, definitionId]);
    }
  };

  for (const parent of parents) {
    await resolveParent(parent, 0, [parent.definitionId]);
  }

  return {
    scopedBindings: new Map(
      [...bindings].map(([parent, table]) => [parent, new Map(table)]),
    ),
    sourceDefinitions: definitions,
    dependencyIndex: new Map(
      [...dependencies].map(([path, owners]) => [path, [...owners].toSorted()]),
    ),
    diagnostics,
  };
}

function sourceDiagnostic(
  code: string,
  parent: AgentFileDefinition,
  alias: string,
  source: string,
  message: string,
  path: string,
): AgentProfileDiagnostic {
  return {
    code,
    severity: 'error',
    message,
    path,
    parentDefinitionId: parent.definitionId,
    alias,
    source,
  };
}

function isWithin(root: string, path: string): boolean {
  const rootId = agentProfileDefinitionId(root);
  const pathId = agentProfileDefinitionId(path);
  const rel = relative(rootId, pathId);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function hasPrivatePathSegment(root: string, path: string): boolean {
  return relative(root, path)
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => segment.toLowerCase() === '_private');
}
