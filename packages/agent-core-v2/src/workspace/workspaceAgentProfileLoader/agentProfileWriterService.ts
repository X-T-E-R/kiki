/**
 * `workspaceAgentProfileLoader` domain — validated agent-profile file writer.
 *
 * Locates one user, project, or extra contribution in the live App registry,
 * stages targeted frontmatter edits while preserving all other bytes, replaces
 * each changed file atomically, explicitly reloads the owning source, and
 * returns the post-reload registry entry. Workspace-scoped.
 */

import { atomicWrite } from '#/_base/utils/fs';
import { Error2 } from '#/_base/errors/errors';
import { CoreErrors } from '#/_base/errors/codes';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { parseAgentFileText } from './internal/agentFile';
import { parseAgentRouteFileText } from './internal/agentRouteFile';
import type { AgentFileSource } from './internal/types';
import type { IExtraAgentProfileLoader } from './extraAgentProfileLoader';
import type { IUserAgentProfileLoader } from './userAgentProfileLoader';
import type { IWorkspaceAgentProfileLoader } from './workspaceAgentProfileLoader';
import { AgentProfileWriteErrors } from './errors';
import type {
  AgentProfileRouteUpdate,
  AgentProfileWriteRequest,
  AgentProfileWriteResult,
  AgentProfileWriteScope,
  IAgentProfileWriter,
} from './agentProfileWriter';

interface ReloadableLoader {
  reload(): Promise<void>;
}

interface StagedWrite {
  readonly path: string;
  readonly text: string;
}

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

type AtomicTextWriter = (path: string, text: string) => Promise<void>;

const SOURCE_BY_SCOPE = {
  user: 'user',
  project: 'workspace',
  extra: 'extra',
} as const;

const FILE_SOURCE_BY_SCOPE: Record<AgentProfileWriteScope, AgentFileSource> = {
  user: 'user',
  project: 'project',
  extra: 'extra',
};

const MODEL_ALIAS_PATTERN = /^\S+$/u;
const TOP_LEVEL_KEYS = new Set(['name', 'scope', 'description', 'modelAlias', 'routes']);
const ROUTE_KEYS = new Set(['id', 'description', 'modelAlias']);

export class AgentProfileWriterService implements IAgentProfileWriter {
  declare readonly _serviceBrand: undefined;

  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly fs: IHostFileSystem,
    private readonly registry: IAgentProfileRegistry,
    private readonly workspace: IWorkspaceContext,
    private readonly userLoader: IUserAgentProfileLoader,
    private readonly workspaceLoader: IWorkspaceAgentProfileLoader,
    private readonly extraLoader: IExtraAgentProfileLoader,
    private readonly atomicTextWriter: AtomicTextWriter = atomicWrite,
  ) {}

  update(request: AgentProfileWriteRequest): Promise<AgentProfileWriteResult> {
    const operation = this.tail.catch(() => undefined).then(() => this.doUpdate(request));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async doUpdate(request: AgentProfileWriteRequest): Promise<AgentProfileWriteResult> {
    validateRequest(request);
    const sourceId = SOURCE_BY_SCOPE[request.scope];
    const registration = this.registry.entries().find(
      (entry) => entry.sourceId === sourceId && entry.workspaceKey === this.workspace.workspaceId,
    );
    const profile = registration?.contribution.profiles.find(
      (candidate) => candidate.name === request.name,
    );
    if (registration === undefined || profile === undefined) {
      this.throwMissingOrReadOnly(request.name, request.scope);
    }
    if (profile.sourcePath === undefined) {
      throw readOnlyError(request.name, registration.sourceId);
    }

    const staged: StagedWrite[] = [];
    const profileText = await this.fs.readText(profile.sourcePath);
    let nextProfileText = profileText;
    if (request.description !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'description', request.description);
    }
    if (request.modelAlias !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'model_alias', request.modelAlias);
      if (request.modelAlias !== null) {
        nextProfileText = updateFrontmatterScalar(nextProfileText, 'model_preference', null);
      }
    }
    parseAgentFileText({
      path: profile.sourcePath,
      source: FILE_SOURCE_BY_SCOPE[request.scope],
      text: nextProfileText,
    });
    if (nextProfileText !== profileText) {
      staged.push({ path: profile.sourcePath, text: nextProfileText });
    }

    const routes = registration.contribution.routes ?? [];
    for (const update of request.routes ?? []) {
      const route = routes.find(
        (candidate) => candidate.id === update.id && candidate.profile === request.name,
      );
      if (route === undefined) {
        throw validationError([
          { path: `routes.${update.id}`, message: `route ${update.id} is not loaded for profile ${request.name}` },
        ]);
      }
      const routeText = await this.fs.readText(route.path);
      let nextRouteText = routeText;
      if (update.description !== undefined) {
        nextRouteText = updateFrontmatterScalar(nextRouteText, 'description', update.description);
      }
      if (update.modelAlias !== undefined) {
        nextRouteText = updateFrontmatterScalar(nextRouteText, 'model_alias', update.modelAlias);
        if (update.modelAlias !== null) {
          nextRouteText = updateFrontmatterScalar(nextRouteText, 'model_preference', null);
        }
      }
      parseAgentRouteFileText({
        path: route.path,
        expectedProfile: request.name,
        expectedRouteName: update.id.slice(update.id.indexOf('.') + 1),
        text: nextRouteText,
      });
      if (nextRouteText !== routeText) staged.push({ path: route.path, text: nextRouteText });
    }

    for (const write of staged) {
      await this.atomicTextWriter(write.path, write.text);
    }
    await this.loaderFor(request.scope).reload();

    const authoritative = this.registry.entries().find(
      (entry) => entry.sourceId === sourceId && entry.workspaceKey === this.workspace.workspaceId,
    );
    const updatedProfile = authoritative?.contribution.profiles.find(
      (candidate) => candidate.name === request.name,
    );
    if (authoritative === undefined || updatedProfile === undefined) {
      throw new Error2(
        AgentProfileWriteErrors.codes.NOT_FOUND,
        `Agent profile "${request.name}" disappeared after ${request.scope} reload`,
        { details: { name: request.name, scope: request.scope } },
      );
    }
    return {
      sourceId,
      workspaceKey: this.workspace.workspaceId,
      profile: updatedProfile,
      routes: (authoritative.contribution.routes ?? []).filter(
        (candidate) => candidate.profile === request.name,
      ),
    };
  }

  private loaderFor(scope: AgentProfileWriteScope): ReloadableLoader {
    if (scope === 'user') return this.userLoader;
    if (scope === 'project') return this.workspaceLoader;
    return this.extraLoader;
  }

  private throwMissingOrReadOnly(name: string, scope: AgentProfileWriteScope): never {
    const match = this.registry.entries().find(
      (entry) =>
        (entry.workspaceKey === undefined || entry.workspaceKey === this.workspace.workspaceId) &&
        entry.contribution.profiles.some((profile) => profile.name === name),
    );
    if (
      match !== undefined &&
      (match.sourceId === 'builtin' ||
        match.sourceId === 'plugin' ||
        match.sourceId === 'explicit' ||
        match.contribution.profiles.find((profile) => profile.name === name)?.sourcePath === undefined)
    ) {
      throw readOnlyError(name, match.sourceId);
    }
    throw new Error2(
      AgentProfileWriteErrors.codes.NOT_FOUND,
      `Agent profile "${name}" was not found in ${scope} scope`,
      { details: { name, scope, workspaceId: this.workspace.workspaceId } },
    );
  }
}

function validateRequest(request: AgentProfileWriteRequest): void {
  const issues: ValidationIssue[] = [];
  if (!isRecord(request)) {
    throw validationError([{ path: '', message: 'request must be an object' }]);
  }
  for (const key of Object.keys(request)) {
    if (!TOP_LEVEL_KEYS.has(key)) issues.push({ path: key, message: `field "${key}" is not editable` });
  }
  if (typeof request.name !== 'string' || request.name.trim() === '') {
    issues.push({ path: 'name', message: 'name must be a non-empty string' });
  }
  if (request.scope !== 'user' && request.scope !== 'project' && request.scope !== 'extra') {
    issues.push({ path: 'scope', message: 'scope must be user, project, or extra' });
  }
  validateDescription(request.description, 'description', issues);
  validateModelAlias(request.modelAlias, 'modelAlias', issues);
  if (request.routes !== undefined) {
    if (!Array.isArray(request.routes)) {
      issues.push({ path: 'routes', message: 'routes must be an array' });
    } else {
      const ids = new Set<string>();
      request.routes.forEach((route, index) => {
        const path = `routes.${index}`;
        if (!isRecord(route)) {
          issues.push({ path, message: 'route update must be an object' });
          return;
        }
        for (const key of Object.keys(route)) {
          if (!ROUTE_KEYS.has(key)) issues.push({ path: `${path}.${key}`, message: `field "${key}" is not editable` });
        }
        if (typeof route['id'] !== 'string' || route['id'].trim() === '') {
          issues.push({ path: `${path}.id`, message: 'id must be a non-empty string' });
        } else if (ids.has(route['id'])) {
          issues.push({ path: `${path}.id`, message: `duplicate route id ${route['id']}` });
        } else {
          ids.add(route['id']);
        }
        validateDescription(route['description'], `${path}.description`, issues);
        validateModelAlias(route['modelAlias'], `${path}.modelAlias`, issues);
        if (route['description'] === undefined && route['modelAlias'] === undefined) {
          issues.push({ path, message: 'route update must include description or modelAlias' });
        }
      });
    }
  }
  if (
    request.description === undefined &&
    request.modelAlias === undefined &&
    (!Array.isArray(request.routes) || request.routes.length === 0)
  ) {
    issues.push({ path: '', message: 'at least one editable field is required' });
  }
  if (issues.length > 0) throw validationError(issues);
}

function validateDescription(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'description must be a non-empty string' });
  }
}

function validateModelAlias(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !MODEL_ALIAS_PATTERN.test(value)) {
    issues.push({ path, message: 'model alias must be a non-empty string without whitespace' });
  }
}

function validationError(issues: readonly ValidationIssue[]): Error2 {
  return new Error2(CoreErrors.codes.VALIDATION_FAILED, issues[0]?.message ?? 'validation failed', {
    details: { issues },
  });
}

function readOnlyError(name: string, source: string): Error2 {
  return new Error2(
    AgentProfileWriteErrors.codes.READ_ONLY,
    `Agent profile "${name}" from source "${source}" is read-only`,
    { details: { name, source } },
  );
}

function updateFrontmatterScalar(text: string, key: string, value: string | null): string {
  const block = locateFrontmatter(text);
  const lines = scanLines(block.content);
  const keyPattern = new RegExp(`^${escapeRegExp(key)}[ \\t]*:`);
  const index = lines.findIndex((line) => keyPattern.test(line.content));
  if (index === -1) {
    if (value === null) return text;
    const eol = preferredEol(text);
    const separator = block.content.length === 0 || block.content.endsWith('\n')
      ? ''
      : eol;
    const inserted = `${block.content}${separator}${key}: ${JSON.stringify(value)}${eol}`;
    return text.slice(0, block.contentStart) + inserted + text.slice(block.contentEnd);
  }

  const line = lines[index]!;
  let end = line.end;
  const rawValue = line.content.slice(line.content.indexOf(':') + 1).trim();
  if (rawValue === '' || rawValue.startsWith('|') || rawValue.startsWith('>')) {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!;
      if (/^[A-Za-z0-9_-]+[ \\t]*:/.test(candidate.content)) break;
      end = candidate.end;
    }
  }
  const replacement = value === null
    ? ''
    : `${key}: ${JSON.stringify(value)}${line.eol || preferredEol(text)}`;
  const absoluteStart = block.contentStart + line.start;
  const absoluteEnd = block.contentStart + end;
  return text.slice(0, absoluteStart) + replacement + text.slice(absoluteEnd);
}

function locateFrontmatter(text: string): {
  readonly content: string;
  readonly contentStart: number;
  readonly contentEnd: number;
} {
  const opening = /^---[ \\t]*(?:\r\n|\n)/.exec(text);
  if (opening === null) throw validationError([{ path: '', message: 'profile file is missing frontmatter' }]);
  let cursor = opening[0].length;
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const contentEnd = lineEnd > cursor && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    if (text.slice(cursor, contentEnd).trim() === '---') {
      return {
        content: text.slice(opening[0].length, cursor),
        contentStart: opening[0].length,
        contentEnd: cursor,
      };
    }
    if (newline === -1) break;
    cursor = newline + 1;
  }
  throw validationError([{ path: '', message: 'profile file has no closing frontmatter fence' }]);
}

function scanLines(text: string): readonly {
  readonly content: string;
  readonly start: number;
  readonly end: number;
  readonly eol: string;
}[] {
  const lines: Array<{ content: string; start: number; end: number; eol: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const newline = text.indexOf('\n', cursor);
    const end = newline === -1 ? text.length : newline + 1;
    const contentEnd = newline === -1
      ? text.length
      : newline > cursor && text[newline - 1] === '\r'
        ? newline - 1
        : newline;
    lines.push({
      content: text.slice(cursor, contentEnd),
      start: cursor,
      end,
      eol: newline === -1 ? '' : text.slice(contentEnd, newline + 1),
    });
    cursor = end;
  }
  return lines;
}

function preferredEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
