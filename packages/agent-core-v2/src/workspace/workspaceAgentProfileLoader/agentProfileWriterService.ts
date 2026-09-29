import { parseSystemMdProfile } from '@kiki/agent-profiles/systemFile';
import { executorPromptSchema } from '@kiki/agent-profiles/executorPrompt';
import { join } from 'pathe';

import { atomicCreate, atomicWrite } from '#/_base/utils/fs';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { EXAMPLE_AGENT_PROFILE_TEMPLATES } from '#/app/shippedAgentProfiles/examples/exampleAgentProfiles';
import { SHIPPED_AGENT_PROFILE_TEMPLATES } from '#/app/shippedAgentProfiles/shippedAgentProfiles';
import { Error2 } from '#/_base/errors/errors';
import { CoreErrors } from '#/_base/errors/codes';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { parseFrontmatter } from '#/_base/text/frontmatter';
import { parseAgentFileText } from './internal/agentFile';
import { projectAgentRoots, userAgentRoots, projectAgentRootCandidates } from './internal/agentRoots';
import { parseAgentRouteFileText } from './internal/agentRouteFile';
import type { AgentFileSource } from './internal/types';
import type { IExtraAgentProfileLoader } from './extraAgentProfileLoader';
import type { IUserAgentProfileLoader } from './userAgentProfileLoader';
import type { IWorkspaceAgentProfileLoader } from './workspaceAgentProfileLoader';
import { AgentProfileWriteErrors } from './errors';
import type {
  AgentProfileCreateRequest,
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
const SERVICE_TIERS = new Set(['auto', 'default', 'flex', 'priority']);
const TOP_LEVEL_KEYS = new Set([
  'name',
  'scope',
  'sourcePath',
  'description',
  'whenToUse',
  'main',
  'executor',
  'executorPrompt',
  'modelAlias',
  'thinkingEffort',
  'allowedModels',
  'denyModels',
  'allowedEfforts',
  'subagents',
  'subagentPolicy',
  'spawnConstraints',
  'modelProfiles',
  'serviceTier',
  'autoCompact',
  'tools',
  'disallowedTools',
  'routes',
  'prompt',
  'rawText',
]);
const ROUTE_KEYS = new Set(['id', 'description', 'modelAlias']);

/** Validated agent-profile file writer (Workspace-scoped): locates one user, project, or extra
 *  contribution in the live App registry, validates targeted frontmatter or whole-file replacements,
 *  writes each changed file atomically, reloads the owning source, and returns the post-reload
 *  registry entry. */
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
    private readonly bootstrap: IBootstrapService,
    private readonly executors: IAgentExecutorRegistry,
    private readonly atomicTextWriter: AtomicTextWriter = atomicWrite,
  ) {}

  create(request: AgentProfileCreateRequest): Promise<AgentProfileWriteResult> {
    const operation = this.tail.catch(() => undefined).then(() => this.doCreate(request));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async doCreate(request: AgentProfileCreateRequest): Promise<AgentProfileWriteResult> {
    validateCreateRequest(request);
    const sourceId = SOURCE_BY_SCOPE[request.scope];
    const exists = this.registry.entries().some((entry) =>
      entry.sourceId === sourceId && entry.workspaceKey === this.workspace.workspaceId
      && entry.contribution.profiles.some((profile) => profile.name === request.name)
    );
    if (exists) throw profileExistsError(request.name);
    if (this.registry.entries().some((entry) => entry.sourceId === 'builtin'
      && entry.contribution.profiles.some((profile) => profile.name === request.name))) {
      throw profileExistsError(request.name);
    }
    const roots = request.scope === 'user'
      ? await userAgentRoots(this.fs, this.bootstrap.userAgentProfileHomeDir, this.bootstrap.osHomeDir)
      : await projectAgentRoots(this.fs, this.workspace.cwd);
    const fallbackRoot = request.scope === 'user'
      ? join(this.bootstrap.userAgentProfileHomeDir, 'agents')
      : (await projectAgentRootCandidates(this.fs, this.workspace.cwd)).candidates[0]!;
    const directory = roots[0]?.path ?? fallbackRoot;
    await this.fs.mkdir(directory, { recursive: true });
    const path = join(await this.fs.realpath(directory), `${request.name}.md`);
    let text: string;
    if (request.template === undefined || request.template === 'blank') {
      text = `---\nname: ${JSON.stringify(request.name)}\ndescription: ${JSON.stringify(request.description)}\n---\n\n${request.prompt}\n`;
    } else if (request.template === 'implementer' || request.template === 'reviewer') {
      text = EXAMPLE_AGENT_PROFILE_TEMPLATES.find((template) => template.id === request.template)!.text;
      text = updateFrontmatterScalar(text, 'name', request.name);
    } else {
      const originalName = request.template.slice('duplicate:'.length);
      const source = this.registry.entries()
        .filter((entry) => entry.workspaceKey === undefined || entry.workspaceKey === this.workspace.workspaceId)
        .toSorted((left, right) => right.priority - left.priority)
        .map((entry) => entry.contribution.profiles.findLast((profile) => profile.name === originalName))
        .find((profile) => profile !== undefined);
      const shipped = SHIPPED_AGENT_PROFILE_TEMPLATES.find((template) => template.id === originalName);
      if (source?.sourcePath !== undefined && !source.sourcePath.includes('://')) {
        text = await this.fs.readText(source.sourcePath);
      } else if (shipped !== undefined) {
        text = shipped.text;
      } else {
        throw validationError([{ path: 'template', message: `profile ${originalName} is unavailable or has no file template` }]);
      }
      text = updateFrontmatterScalar(text, 'name', request.name);
      text = updateFrontmatterScalar(text, 'override', null);
    }
    if (request.main !== undefined) text = updateFrontmatterScalar(text, 'main', request.main);
    if (request.description !== undefined) text = updateFrontmatterScalar(text, 'description', request.description);
    if (request.whenToUse !== undefined) text = updateFrontmatterScalar(text, 'whenToUse', request.whenToUse);
    if (request.modelAlias !== undefined) text = updateFrontmatterScalar(text, 'model_alias', request.modelAlias);
    if (request.thinkingEffort !== undefined) text = updateFrontmatterScalar(text, 'thinking_effort', request.thinkingEffort);
    if (request.tools !== undefined) text = updateFrontmatterScalar(text, 'tools', request.tools);
    if (request.prompt !== undefined && request.template !== undefined && request.template !== 'blank') {
      text = replacePromptBody(text, request.prompt);
    }
    const parsed = parseAgentFileText({ path, source: FILE_SOURCE_BY_SCOPE[request.scope], text });
    if (parsed.name !== request.name) throw validationError([{ path: 'name', message: 'profile name does not match request' }]);
    try {
      await atomicCreate(path, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw profileExistsError(request.name);
      throw error;
    }
    await this.loaderFor(request.scope).reload();
    const registration = this.registry.entries().find((entry) =>
      entry.sourceId === sourceId && entry.workspaceKey === this.workspace.workspaceId
    );
    const profile = registration?.contribution.profiles.find((candidate) =>
      candidate.name === request.name && candidate.sourcePath === path
    );
    if (profile === undefined) throw new Error2(AgentProfileWriteErrors.codes.PROFILE_NOT_FOUND,
      `Agent profile "${request.name}" did not load after creation`);
    return { sourceId, workspaceKey: this.workspace.workspaceId, profile, routes: [] };
  }

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
    const profile = registration?.contribution.profiles.findLast(
      (candidate) => candidate.name === request.name
        && (request.sourcePath === undefined || candidate.sourcePath === request.sourcePath),
    );
    if (registration === undefined || profile === undefined) {
      if (request.sourcePath !== undefined) {
        throw new Error2(AgentProfileWriteErrors.codes.PROFILE_NOT_FOUND,
          `Agent profile "${request.name}" is not loaded from the requested source file`);
      }
      this.throwMissingOrReadOnly(request.name, request.scope);
    }
    if (profile.sourcePath === undefined) {
      throw readOnlyError(request.name, registration.sourceId);
    }

    const system = request.scope === 'user'
      && this.userLoader.getDefaultProfile().sourcePath === profile.sourcePath;
    const staged: StagedWrite[] = [];
    const profileText = await this.fs.readText(profile.sourcePath);
    let nextProfileText = request.rawText ?? profileText;
    if (request.description !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'description', request.description);
    }
    if (request.whenToUse !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'whenToUse', request.whenToUse);
    }
    if (request.modelAlias !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'model_alias', request.modelAlias);
      if (request.modelAlias !== null) {
        nextProfileText = updateFrontmatterScalar(nextProfileText, 'model_preference', null);
      }
    }
    if (request.thinkingEffort !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'thinking_effort', request.thinkingEffort);
    }
    if (request.main !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'main', request.main);
    }
    if (request.executor !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'executor', request.executor);
    }
    if (request.executorPrompt !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'executor_prompt', request.executorPrompt);
    }
    if (request.allowedModels !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'allowed_models', request.allowedModels);
    }
    if (request.denyModels !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'deny_models', request.denyModels);
    }
    if (request.allowedEfforts !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'allowed_efforts', request.allowedEfforts);
    }
    if (request.subagentPolicy !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'subagent_policy', request.subagentPolicy);
    }
    if (request.spawnConstraints !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'spawn_constraints', request.spawnConstraints === null
        ? null : {
            allowed_models: request.spawnConstraints.allowedModels,
            deny_models: request.spawnConstraints.denyModels,
            allowed_efforts: request.spawnConstraints.allowedEfforts,
            disallowed_tools: request.spawnConstraints.disallowedTools,
          });
    }
    if (request.subagents !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'subagents', request.subagents === null
        ? null
        : mergeSubagentEntries(frontmatterField(nextProfileText, 'subagents'), request.subagents));
    }
    if (request.modelProfiles !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'model_profiles', request.modelProfiles === null
        ? null
        : mergeModelProfileEntries(frontmatterField(nextProfileText, 'model_profiles'), request.modelProfiles));
    }
    if (request.serviceTier !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'service_tier', request.serviceTier);
    }
    if (request.autoCompact !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'auto_compact', request.autoCompact);
    }
    if (request.tools !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'tools', request.tools);
    }
    if (request.disallowedTools !== undefined) {
      nextProfileText = updateFrontmatterScalar(nextProfileText, 'disallowedTools', request.disallowedTools);
    }
    if (request.prompt !== undefined) {
      nextProfileText = system && !nextProfileText.startsWith('---')
        ? `${request.prompt}${preferredEol(profileText)}`
        : replacePromptBody(nextProfileText, request.prompt);
    }
    if (system) {
      if (nextProfileText.trim() === '') {
        throw validationError([{ path: 'rawText', message: 'SYSTEM.md must not be empty' }]);
      }
      try {
        if (nextProfileText.split(/\r?\n/, 1)[0]?.trim() === '---') {
          parseAgentFileText({
            path: profile.sourcePath,
            source: 'user',
            text: nextProfileText,
            forceName: request.name,
            forceOverride: true,
            fallbackDescription: this.userLoader.getBuiltinDefault().description,
          });
        }
        parseSystemMdProfile(nextProfileText, profile.sourcePath, this.userLoader.getBuiltinDefault(), () => {});
      } catch (error) {
        throw validationError([{ path: 'rawText', message: String(error) }]);
      }
    } else {
      const parsedProfile = parseAgentFileText({
        path: profile.sourcePath,
        source: FILE_SOURCE_BY_SCOPE[request.scope],
        text: nextProfileText,
      });
      if (parsedProfile.name !== request.name) {
        throw validationError([{
          path: 'rawText',
          message: `profile name must remain ${request.name}`,
        }]);
      }
      if (parsedProfile.executor !== undefined && parsedProfile.executor !== 'native') {
        const validation = this.executors.validateBinding(parsedProfile.executor, parsedProfile.executorOptions, {
          modelAlias: parsedProfile.modelAlias,
          thinkingEffort: parsedProfile.thinkingEffort,
        });
        if (!validation.ok) throw validationError([{ path: 'executor', message: validation.diagnostic }]);
      }
    }
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
    const updatedProfile = authoritative?.contribution.profiles.findLast(
      (candidate) => candidate.name === request.name && candidate.sourcePath === profile.sourcePath,
    );
    if (authoritative === undefined || updatedProfile === undefined) {
      throw new Error2(
        AgentProfileWriteErrors.codes.PROFILE_NOT_FOUND,
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
        match.sourceId === 'inherited' ||
    ) {
      throw readOnlyError(name, match.sourceId);
    }
    throw new Error2(
      AgentProfileWriteErrors.codes.PROFILE_NOT_FOUND,
      `Agent profile "${name}" was not found in ${scope} scope`,
      { details: { name, scope, workspaceId: this.workspace.workspaceId } },
    );
  }
}

function profileExistsError(name: string): Error2 {
  return new Error2(AgentProfileWriteErrors.codes.PROFILE_ALREADY_EXISTS,
    `Agent profile "${name}" already exists`);
}

function validateCreateRequest(request: AgentProfileCreateRequest): void {
  const issues: ValidationIssue[] = [];
  if (!isRecord(request)) throw validationError([{ path: '', message: 'request must be an object' }]);
  if (typeof request.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.name)) {
    issues.push({ path: 'name', message: 'name must be kebab-case' });
  }
  if (request.scope !== 'user' && request.scope !== 'project') {
    issues.push({ path: 'scope', message: 'scope must be user or project' });
  }
  if (request.template !== undefined && request.template !== 'blank'
    && request.template !== 'implementer' && request.template !== 'reviewer'
    && (typeof request.template !== 'string' || !/^duplicate:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.template))) {
    issues.push({ path: 'template', message: 'unknown profile template' });
  }
  if (request.main !== undefined && typeof request.main !== 'boolean') {
    issues.push({ path: 'main', message: 'main must be boolean' });
  }
  validateRequiredString(request.description, 'description', issues);
  validateRequiredString(request.whenToUse, 'whenToUse', issues);
  validateModelAlias(request.modelAlias, 'modelAlias', issues);
  validateRequiredString(request.thinkingEffort, 'thinkingEffort', issues);
  validateStringList(request.tools, 'tools', issues);
  if (request.prompt !== undefined && typeof request.prompt !== 'string') {
    issues.push({ path: 'prompt', message: 'prompt must be a string' });
  }
  if (request.template === undefined || request.template === 'blank') {
    if (request.description === undefined) issues.push({ path: 'description', message: 'description is required' });
    if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
      issues.push({ path: 'prompt', message: 'prompt is required' });
    }
  }
  if (issues.length > 0) throw validationError(issues);
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
  validateRequiredString(request.sourcePath, 'sourcePath', issues);
  validateRequiredString(request.description, 'description', issues);
  validateOptionalString(request.whenToUse, 'whenToUse', issues);
  validateModelAlias(request.modelAlias, 'modelAlias', issues);
  validateOptionalString(request.thinkingEffort, 'thinkingEffort', issues);
  validateServiceTier(request.serviceTier, issues);
  if (request.autoCompact !== undefined && request.autoCompact !== null &&
      (!Number.isSafeInteger(request.autoCompact) || request.autoCompact <= 0)) {
    issues.push({ path: 'autoCompact', message: 'profile auto_compact must be an absolute positive integer token count' });
  }
  validateStringList(request.tools, 'tools', issues);
  validateStringList(request.disallowedTools, 'disallowedTools', issues);
  if (request.main !== undefined && request.main !== null && typeof request.main !== 'boolean') {
    issues.push({ path: 'main', message: 'main must be boolean or null' });
  }
  validateOptionalString(request.executor, 'executor', issues);
  if (request.executorPrompt !== undefined && request.executorPrompt !== null) {
    const parsed = executorPromptSchema.safeParse(request.executorPrompt);
    if (!parsed.success) issues.push({ path: 'executorPrompt', message: parsed.error.message });
  }
  validateStringList(request.allowedModels, 'allowedModels', issues);
  validateStringList(request.denyModels, 'denyModels', issues);
  validateStringList(request.allowedEfforts, 'allowedEfforts', issues);
  if (request.subagentPolicy !== undefined && request.subagentPolicy !== null
    && request.subagentPolicy !== 'advisory' && request.subagentPolicy !== 'strict') {
    issues.push({ path: 'subagentPolicy', message: 'subagentPolicy must be advisory, strict, or null' });
  }
  if (request.spawnConstraints !== undefined && request.spawnConstraints !== null) {
    if (!isRecord(request.spawnConstraints)) {
      issues.push({ path: 'spawnConstraints', message: 'spawnConstraints must be a mapping or null' });
    } else {
      for (const [key, value] of Object.entries(request.spawnConstraints)) {
        if (!['allowedModels', 'denyModels', 'allowedEfforts', 'disallowedTools'].includes(key)) {
          issues.push({ path: `spawnConstraints.${key}`, message: `unknown spawn constraint "${key}"` });
        } else {
          validateStringList(value, `spawnConstraints.${key}`, issues);
          if (value === null) issues.push({ path: `spawnConstraints.${key}`, message: 'constraint lists cannot be null' });
        }
      }
    }
  }
  validateSubagentUpdates(request.subagents, issues);
  validateModelProfileUpdates(request.modelProfiles, issues);
  if (request.prompt !== undefined && typeof request.prompt !== 'string') {
    issues.push({ path: 'prompt', message: 'prompt must be a string' });
  }
  if (request.rawText !== undefined && typeof request.rawText !== 'string') {
    issues.push({ path: 'rawText', message: 'rawText must be a string' });
  }
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
        validateRequiredString(route['description'], `${path}.description`, issues);
        validateModelAlias(route['modelAlias'], `${path}.modelAlias`, issues);
        if (route['description'] === undefined && route['modelAlias'] === undefined) {
          issues.push({ path, message: 'route update must include description or modelAlias' });
        }
      });
    }
  }
  const structuredFields = [
    request.description,
    request.whenToUse,
    request.main,
    request.executor,
    request.executorPrompt,
    request.modelAlias,
    request.thinkingEffort,
    request.allowedModels,
    request.denyModels,
    request.allowedEfforts,
    request.subagents,
    request.subagentPolicy,
    request.spawnConstraints,
    request.modelProfiles,
    request.serviceTier,
    request.autoCompact,
    request.tools,
    request.disallowedTools,
    request.prompt,
  ];
  const hasStructuredUpdate = structuredFields.some((value) => value !== undefined)
    || (Array.isArray(request.routes) && request.routes.length > 0);
  if (request.rawText !== undefined && hasStructuredUpdate) {
    issues.push({ path: 'rawText', message: 'rawText cannot be combined with field or route updates' });
  }
  if (request.rawText === undefined && !hasStructuredUpdate) {
    issues.push({ path: '', message: 'at least one editable field or rawText is required' });
  }
  if (issues.length > 0) throw validationError(issues);
}

function validateRequiredString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: `${path} must be a non-empty string` });
  }
}

function validateOptionalString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: `${path} must be a non-empty string or null` });
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

function validateServiceTier(value: unknown, issues: ValidationIssue[]): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !SERVICE_TIERS.has(value)) {
    issues.push({ path: 'serviceTier', message: 'serviceTier must be auto, default, flex, priority, or null' });
  }
}

function validateStringList(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${path} must be an array of non-empty strings or null` });
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push({ path: `${path}.${index}`, message: `${path} entries must be non-empty strings` });
    }
  });
}

function validationError(issues: readonly ValidationIssue[]): Error2 {
  return new Error2(CoreErrors.codes.VALIDATION_FAILED, issues[0]?.message ?? 'validation failed', {
    details: { issues },
  });
}

function readOnlyError(name: string, source: string): Error2 {
  return new Error2(
    AgentProfileWriteErrors.codes.PROFILE_READ_ONLY,
    `Agent profile "${name}" from source "${source}" is read-only`,
    { details: { name, source } },
  );
}

function frontmatterField(text: string, key: string): unknown {
  try {
    const { data } = parseFrontmatter(text);
    return isRecord(data) ? data[key] : undefined;
  } catch {
    return undefined;
  }
}

function withKeyUpdates(
  base: Record<string, unknown>,
  updates: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const next = { ...base };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function mergeSubagentEntries(
  current: unknown,
  updates: NonNullable<AgentProfileWriteRequest['subagents']>,
): unknown[] {
  const existing = new Map<string, Record<string, unknown>>();
  if (Array.isArray(current)) {
    for (const item of current) {
      if (isRecord(item) && typeof item['name'] === 'string') existing.set(item['name'], item);
    }
  }
  return updates.map((entry) => {
    const name = typeof entry === 'string' ? entry.trim() : entry.name.trim();
    const prior = existing.get(name);
    if (typeof entry === 'string') return prior ?? name;
    const merged = withKeyUpdates(prior ?? { name }, {
      model_alias: entry.modelAlias,
      thinking_effort: entry.thinkingEffort,
      allowed_models: entry.allowedModels,
    });
    return Object.keys(merged).length === 1 ? name : merged;
  });
}

function mergeModelProfileEntries(
  current: unknown,
  updates: NonNullable<AgentProfileWriteRequest['modelProfiles']>,
): Record<string, unknown>[] {
  const existing = new Map<string, Record<string, unknown>>();
  if (Array.isArray(current)) {
    for (const item of current) {
      if (isRecord(item) && typeof item['alias'] === 'string') existing.set(item['alias'], item);
    }
  }
  return updates.map((entry) => withKeyUpdates(existing.get(entry.alias) ?? { alias: entry.alias }, {
    when: entry.when,
    thinking_effort: entry.thinkingEffort,
  }));
}

function validateSubagentUpdates(value: unknown, issues: ValidationIssue[]): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.push({ path: 'subagents', message: 'subagents must be an array or null' });
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const path = `subagents.${index}`;
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? entry['name'] : undefined;
    if (typeof name !== 'string' || name.trim() === '') {
      issues.push({ path, message: 'subagent entries must name a profile' });
      return;
    }
    if (seen.has(name.trim())) issues.push({ path, message: `duplicate subagent ${name.trim()}` });
    seen.add(name.trim());
    if (!isRecord(entry)) return;
    for (const key of Object.keys(entry)) {
      if (!['name', 'modelAlias', 'thinkingEffort', 'allowedModels'].includes(key)) {
        issues.push({ path: `${path}.${key}`, message: `field "${key}" is not editable` });
      }
    }
    validateModelAlias(entry['modelAlias'], `${path}.modelAlias`, issues);
    validateOptionalString(entry['thinkingEffort'], `${path}.thinkingEffort`, issues);
    validateStringList(entry['allowedModels'], `${path}.allowedModels`, issues);
  });
}

function validateModelProfileUpdates(value: unknown, issues: ValidationIssue[]): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    issues.push({ path: 'modelProfiles', message: 'modelProfiles must be an array or null' });
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const path = `modelProfiles.${index}`;
    if (!isRecord(entry) || typeof entry['alias'] !== 'string' || !MODEL_ALIAS_PATTERN.test(entry['alias'])) {
      issues.push({ path: `${path}.alias`, message: 'model profile entries need an alias without whitespace' });
      return;
    }
    if (seen.has(entry['alias'])) issues.push({ path, message: `duplicate model profile ${entry['alias']}` });
    seen.add(entry['alias']);
    for (const key of Object.keys(entry)) {
      if (!['alias', 'when', 'thinkingEffort'].includes(key)) {
        issues.push({ path: `${path}.${key}`, message: `field "${key}" is not editable` });
      }
    }
    validateOptionalString(entry['when'], `${path}.when`, issues);
    validateOptionalString(entry['thinkingEffort'], `${path}.thinkingEffort`, issues);
  });
}

function replacePromptBody(text: string, prompt: string): string {
  const block = locateFrontmatter(text);
  const newline = text.indexOf('\n', block.contentEnd);
  const prefix = newline === -1 ? `${text}${preferredEol(text)}` : text.slice(0, newline + 1);
  const eol = preferredEol(text);
  return `${prefix}${eol}${prompt.trim()}${eol}`;
}

function updateFrontmatterScalar(
  text: string,
  key: string,
  value: string | number | boolean | readonly unknown[] | Readonly<Record<string, unknown>> | null,
): string {
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
  } else {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!;
      if (!/^\s+\S/.test(candidate.content)) break;
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
