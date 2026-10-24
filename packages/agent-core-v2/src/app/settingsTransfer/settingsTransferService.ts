import { randomUUID } from 'node:crypto';
import { validatePromptOverridePath } from '@kiki/agent-profiles/promptOverrides';
import {
  SETTINGS_TRANSFER_CATEGORIES,
  SETTINGS_TRANSFER_MAX_BYTES,
  settingsTransferExportInputSchema,
  settingsTransferPackageSchema,
  settingsTransferPreviewInputSchema,
  type SettingsTransferApplyResult,
  type SettingsTransferCategory,
  type SettingsTransferCategorySummary,
  type SettingsTransferExportInput,
  type SettingsTransferNotice,
  type SettingsTransferPackage,
  type SettingsTransferPreviewInput,
  type SettingsTransferResource,
} from '@kiki/protocol';
import type { CollectionView } from '#/_base/di/collection';
import { Disposable } from '#/_base/di/lifecycle';
import { ConfigWriteValidatorContribution, type ConfigWriteValidator } from '#/app/config/configWriteValidation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ConfigTarget, IConfigRegistry, IConfigService } from '#/app/config/config';
import { deepEqual, isPlainObject } from '#/app/config/configPure';
import { IMcpConfigStore, type GlobalMcpServerConfig } from '#/app/mcpConfig/configStore';
import { IMcpRegistryService, type McpRegistryEntry } from '#/app/mcpRegistry/mcpRegistry';
import type { NbSearchConfig } from '#/app/nbSearch/configSection';
import { INbSearchTransferCredentials, type NbSearchTransferCredentialState } from '#/app/nbSearch/transferCredentials';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { McpServerConfigSchema } from '#/mcpCore/config-schema';
import { ISettingsProfileResources } from './profileResources';
import { ISettingsTransferService } from './settingsTransfer';
import { assertSafeKeys, atPath, categoryForDomain, categoryForUnit, classifyUnit, configUnits, mergeSelected, portableValue, projectConfig, setPath, unsafeUrl } from './transferData';

type FileResource = Exclude<SettingsTransferResource, { kind: 'nbSearchCredential' }>;
interface ResourcePlan {
  readonly resource: FileResource;
  readonly category: SettingsTransferCategory;
  readonly before: unknown;
  readonly next: unknown;
}
interface CredentialPlan {
  readonly resource: Extract<SettingsTransferResource, { kind: 'nbSearchCredential' }>;
  readonly before: NbSearchTransferCredentialState;
  readonly config: NbSearchConfig | undefined;
  readonly reuseLocalConfig: boolean;
  readonly write: boolean;
}
interface Plan {
  readonly expires: number;
  readonly before: Record<string, unknown>;
  readonly effectiveBefore: Record<string, unknown>;
  readonly sections: Record<string, unknown>;
  readonly resources: readonly ResourcePlan[];
  readonly guards: readonly ResourcePlan[];
  readonly mcpBefore: ReadonlyMap<string, McpRegistryEntry | undefined>;
  readonly credentials: readonly CredentialPlan[];
}
const NOTICES: SettingsTransferNotice[] = ['localScope', 'externalLogins', 'localPaths', 'pluginCode', 'profileScope'];
const extraScalars = new Set(['defaultModel', 'defaultProvider']);

export class SettingsTransferService extends Disposable implements ISettingsTransferService {
  declare readonly _serviceBrand: undefined;
  private readonly previews = new Map<string, Plan>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IConfigRegistry private readonly registry: IConfigRegistry,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IMcpConfigStore private readonly mcp: IMcpConfigStore,
    @ISettingsProfileResources private readonly profiles: ISettingsProfileResources,
    @ConfigWriteValidatorContribution private readonly validators: CollectionView<ConfigWriteValidator>,
    @IMcpRegistryService private readonly mcpRegistry: IMcpRegistryService,
    @INbSearchTransferCredentials private readonly searchCredentials: INbSearchTransferCredentials,
  ) { super(); this._register({ dispose: () => { this.previews.clear(); } }); }

  private scope() { return { home: this.bootstrap.homeDir, spaceId: this.bootstrap.spaceId }; }

  async catalog() {
    const bundle = await this.export({ categories: [...SETTINGS_TRANSFER_CATEGORIES], includeCredentials: false });
    const categories = SETTINGS_TRANSFER_CATEGORIES.map(summary);
    for (const [domain, value] of Object.entries(bundle.config)) {
      for (const unit of configUnits(domain, value)) categories.find((entry) => entry.id === categoryForUnit(unit.path))!.items += 1;
    }
    for (const resource of bundle.resources) categories.find((entry) => entry.id === resourceCategory(resource))!.items += 1;
    return { scope: this.scope(), categories, notices: bundle.notices };
  }

  async export(rawInput: SettingsTransferExportInput): Promise<SettingsTransferPackage> {
    const input = safeParse(settingsTransferExportInputSchema, rawInput);
    await this.config.ready;
    await this.config.reload();
    const notices = new Set<SettingsTransferNotice>(NOTICES);
    if (!input.includeCredentials) notices.add('omittedCredentials');
    const config: Record<string, unknown> = {};
    const domains = new Set([...this.registry.listSections().map((section) => section.domain), ...extraScalars]);
    for (const domain of domains) {
      const category = categoryForDomain(domain);
      if (category === undefined || (domain !== 'experimental' && !input.categories.includes(category))) continue;
      const own = this.config.inspect(domain).userValue;
      if (own === undefined) continue;
      let value = projectConfig(domain, own, input.includeCredentials, notices);
      if (domain === 'experimental' && isPlainObject(value)) value = Object.fromEntries(Object.entries(value).filter(([key]) => input.categories.includes(categoryForUnit([domain, key])!)));
      if (value !== undefined && (!isPlainObject(value) || Object.keys(value).length > 0)) config[domain] = value;
    }
    const resources: SettingsTransferResource[] = [];
    if (input.categories.includes('agents')) {
      try { for (const resource of await this.profiles.list()) resources.push({ kind: 'profile', ...resource }); }
      catch { throw invalid('referencedPromptFile'); }
    }
    for (const [domain, value] of Object.entries(config)) {
      const category = categoryForDomain(domain);
      if (category !== 'agents' && category !== 'models') continue;
      for (const key of promptReferences(value)) {
        if (resources.some((resource) => resource.kind === 'profile' && resource.key === key && resourceCategory(resource) === category)) continue;
        try {
          const text = await this.profiles.read(key);
          if (text === undefined) throw invalid();
          this.profiles.validate({ key, text });
          resources.push({ kind: 'profile', key, text, category });
        } catch { throw invalid('referencedPromptFile'); }
      }
    }
    if (input.categories.includes('tools')) {
      for (const { name, ...entry } of await this.mcp.list()) {
        if (!input.includeCredentials && mcpInlineCredentials(entry)) { notices.add('omittedCredentials'); continue; }
        const value = portableValue(entry, input.includeCredentials);
        if (isPlainObject(value)) resources.push({ kind: 'mcp', key: name, value: value as Extract<SettingsTransferResource, {kind: 'mcp'}>['value'] });
      }
      if (input.includeCredentials) {
        try { resources.push(...await this.searchCredentials.export(this.config.get<NbSearchConfig | undefined>('nbSearch'), this.reuseLocalSearch())); }
        catch { throw invalid('searchCredentials'); }
      }
    }
    const bundle = safeParse(settingsTransferPackageSchema, {
      format: 'kiki.settings', version: 1, createdAt: new Date().toISOString(), categories: [...new Set(input.categories)],
      includesCredentials: input.includeCredentials, config, resources, notices: [...notices],
    });
    assertSize(bundle);
    return bundle;
  }

  async preview(rawInput: SettingsTransferPreviewInput) {
    const input = safeParse(settingsTransferPreviewInputSchema, rawInput);
    assertSize(input.bundle);
    try { assertSafeKeys(input.bundle); } catch { throw invalid(); }
    if (new Set(input.bundle.categories).size !== input.bundle.categories.length) throw invalid();
    if (input.categories.some((category) => !input.bundle.categories.includes(category))) throw invalid();
    if (input.includeCredentials && !input.bundle.includesCredentials) throw invalid();
    await this.config.ready;
    await this.config.reload();
    if (this.bootstrap.configReadOnly || this.config.diagnostics().some((entry) => entry.severity === 'error')) throw invalid('targetConfiguration');
    const summaries = SETTINGS_TRANSFER_CATEGORIES.filter((category) => input.bundle.categories.includes(category)).map(summary);
    const before: Record<string, unknown> = {};
    const effectiveBefore: Record<string, unknown> = {};
    const sections: Record<string, unknown> = {};
    const notices = new Set<SettingsTransferNotice>(input.bundle.notices);
    for (const [domain, rawValue] of Object.entries(input.bundle.config)) {
      if (categoryForDomain(domain) === undefined) throw invalid('category');
      if (this.registry.getSection(domain) === undefined && !extraScalars.has(domain)) throw invalid('configuration');
      const incoming = projectConfig(domain, rawValue, input.includeCredentials, notices);
      if (incoming === undefined) continue;
      this.validateDomain(domain, incoming);
      const current = this.config.inspect(domain).userValue;
      let selected = false;
      const domainRoot: Record<string, unknown> = { [domain]: structuredClone(current) };
      for (const unit of configUnits(domain, incoming)) {
        const category = categoryForUnit(unit.path)!;
        if (!input.bundle.categories.includes(category)) throw invalid('category');
        const stats = summaries.find((entry) => entry.id === category)!;
        stats.items += 1;
        if (!input.categories.includes(category)) { stats.skipped += 1; continue; }
        selected = true;
        const own = atPath({ [domain]: current }, unit.path);
        const existing = input.mode === 'append' ? this.existingUnit(domain, unit.path, own) : own;
        const classification = classifyUnit(existing, unit.value);
        stats[classification] += 1;
        if (classification === 'unchanged' || (input.mode === 'append' && existing !== undefined)) {
          stats.skipped += 1;
          continue;
        }
        setPath(domainRoot, unit.path, mergeSelected(own, unit.value, input.mode));
      }
      if (!selected) continue;
      before[domain] = structuredClone(current);
      effectiveBefore[domain] = structuredClone(this.config.get(domain));
      const next = domainRoot[domain];
      if (!deepEqual(current, next)) {
        this.validateDomain(domain, next);
        sections[domain] = next;
      }
    }
    this.validateModelLinks(sections);
    const resources: ResourcePlan[] = [];
    const guards: ResourcePlan[] = [];
    const keys = new Set<string>();
    const profileKeys = new Map<string, Extract<SettingsTransferResource, { kind: 'profile' }>>();
    const currentMcp = await this.mcp.list();
    const effectiveMcp = await this.globalMcp();
    const mcpBefore = new Map<string, McpRegistryEntry | undefined>();
    const credentials: CredentialPlan[] = [];
    for (const resource of input.bundle.resources) {
      const category = resourceCategory(resource);
      const key = resource.kind === 'profile' ? this.resourceKey(resource.key) : resource.key;
      const identity = `${resource.kind}:${category}:${key}`;
      if (keys.has(identity)) throw invalid('duplicateResource');
      keys.add(identity);
      if (resource.kind === 'profile') {
        const previous = profileKeys.get(key);
        if (previous !== undefined && (previous.text !== resource.text || previous.key !== resource.key)) throw invalid('duplicateResource');
        profileKeys.set(key, resource);
      }
      if (!input.bundle.categories.includes(category)) throw invalid();
      const stats = summaries.find((entry) => entry.id === category)!;
      stats.items += 1;
      if (resource.kind === 'nbSearchCredential') {
        if (!input.categories.includes(category) || !input.includeCredentials) {
          stats.skipped += 1;
          if (!input.includeCredentials) notices.add('omittedCredentials');
          continue;
        }
        for (const domain of ['nbSearch', 'nbSearchSource']) {
          if (!Object.hasOwn(before, domain)) before[domain] = structuredClone(this.config.inspect(domain).userValue);
          effectiveBefore[domain] = structuredClone(this.config.get(domain));
        }
        const config = mergeSelected(this.config.get('nbSearch'), sections['nbSearch'] ?? {}, 'overwrite') as NbSearchConfig | undefined;
        const reuseLocalConfig = this.reuseLocalSearch(sections['nbSearchSource']);
        let state: NbSearchTransferCredentialState;
        try { state = await this.searchCredentials.inspect(config, reuseLocalConfig, resource.key); }
        catch { throw invalid('searchCredentialBinding'); }
        const classification = !state.occupied ? 'added' : state.active && state.value === resource.value ? 'unchanged' : 'conflicts';
        stats[classification] += 1;
        const write = classification !== 'unchanged' && (input.mode === 'overwrite' || !state.occupied);
        if (write && !deepEqual(state.binding, resource.binding)) throw invalid('searchCredentialBinding');
        if (!write) stats.skipped += 1;
        credentials.push({ resource, before: state, config, reuseLocalConfig, write });
        continue;
      }
      let incoming: unknown;
      let current: unknown;
      if (resource.kind === 'profile') {
        if (category === 'models' && !resource.key.endsWith('.toml')) throw invalid('profileCategory');
        try {
          this.profiles.validate({ key: resource.key, text: resource.text });
          current = await this.profiles.read(resource.key);
        } catch { throw invalid('profile'); }
        incoming = resource.text;
      } else {
        if (!input.includeCredentials && mcpInlineCredentials(resource.value)) {
          stats.skipped += 1;
          notices.add('omittedCredentials');
          continue;
        }
        incoming = portableValue(resource.value, input.includeCredentials);
        try { McpServerConfigSchema.parse(incoming); } catch { throw invalid(); }
        current = currentMcp.find((entry) => entry.name === resource.key);
        if (current !== undefined) { const { name: _name, ...entry } = current as GlobalMcpServerConfig; current = entry; }
      }
      if (!input.categories.includes(category)) { stats.skipped += 1; continue; }
      const effective = resource.kind === 'mcp' ? effectiveMcp.get(resource.key) : undefined;
      if (resource.kind === 'mcp') mcpBefore.set(resource.key, effective);
      const existing = resource.kind === 'mcp' && input.mode === 'append' ? effective?.config : current;
      const classification = classifyUnit(existing, incoming);
      stats[classification] += 1;
      guards.push({ resource, category, before: current, next: incoming });
      if (classification === 'unchanged' || (input.mode === 'append' && existing !== undefined)) { stats.skipped += 1; continue; }
      const next = resource.kind === 'mcp' ? mergeSelected(current, incoming, 'overwrite') : incoming;
      if (!resources.some((entry) => entry.resource.kind === resource.kind && this.resourceKey(entry.resource.key) === key)) resources.push({ resource, category, before: current, next });
    }
    const refs = new Set(Object.values(sections).flatMap(promptReferences));
    for (const entry of resources) {
      if (entry.resource.kind !== 'profile') continue;
      for (const key of this.profiles.references({ key: entry.resource.key, text: entry.next as string })) refs.add(key);
    }
    for (const key of refs) {
      const planned = resources.find((entry) => entry.resource.kind === 'profile' && this.resourceKey(entry.resource.key) === this.resourceKey(key));
      if (planned !== undefined) continue;
      try {
        const text = await this.profiles.read(key);
        if (text === undefined) throw invalid();
        this.profiles.validate({ key, text });
        guards.push({ resource: { kind: 'profile', key, text }, category: 'agents', before: text, next: text });
      } catch { throw invalid('referencedPromptFile'); }
    }
    resources.sort((left, right) => Number(right.resource.kind === 'profile' && right.resource.key.endsWith('.toml')) - Number(left.resource.kind === 'profile' && left.resource.key.endsWith('.toml')));
    for (const [key, plan] of this.previews) if (plan.expires < Date.now()) this.previews.delete(key);
    while (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value!);
    const previewId = randomUUID();
    this.previews.set(previewId, { expires: Date.now() + 10 * 60_000, before, effectiveBefore, sections, resources, guards, mcpBefore, credentials });
    return { scope: this.scope(), categories: summaries, notices: [...notices], previewId, includesCredentials: input.bundle.includesCredentials, credentialsSelected: input.includeCredentials, mode: input.mode };
  }

  async cancel(input: { previewId: string }): Promise<void> { this.previews.delete(input.previewId); }

  apply(input: { previewId: string }): Promise<SettingsTransferApplyResult> {
    const work = this.tail.then(() => this.applyPlan(input.previewId));
    this.tail = work.catch(() => undefined);
    return work;
  }

  private async applyPlan(previewId: string): Promise<SettingsTransferApplyResult> {
    const plan = this.previews.get(previewId);
    this.previews.delete(previewId);
    const result: SettingsTransferApplyResult = { status: 'failed', scope: this.scope(), items: [], timing: 'settingsReloaded' };
    if (plan === undefined || plan.expires < Date.now()) return { ...result, failure: 'expired' };
    try {
      await this.config.reload();
      for (const [domain, value] of Object.entries(plan.before)) {
        if (!deepEqual(this.config.inspect(domain).userValue, value)) return { ...result, failure: 'changed' };
      }
      for (const [domain, value] of Object.entries(plan.effectiveBefore)) {
        if (!deepEqual(this.config.get(domain), value)) return { ...result, failure: 'changed' };
      }
      for (const entry of plan.guards) {
        if (!deepEqual(await this.readResource(entry.resource), entry.before)) return { ...result, failure: 'changed' };
      }
      const effectiveMcp = await this.globalMcp();
      for (const [key, entry] of plan.mcpBefore) if (!deepEqual(effectiveMcp.get(key), entry)) return { ...result, failure: 'changed' };
      for (const entry of plan.credentials) {
        const current = await this.searchCredentials.inspect(entry.config, entry.reuseLocalConfig, entry.resource.key);
        if (current.version !== entry.before.version || current.bindingVersion !== entry.before.bindingVersion || current.occupied !== entry.before.occupied) return { ...result, failure: 'changed' };
      }
    } catch { return { ...result, failure: 'readbackFailed' }; }
    let failure: SettingsTransferApplyResult['failure'];
    for (const entry of plan.resources) {
      try {
        if (entry.resource.kind === 'profile') await this.profiles.write({ key: entry.resource.key, text: entry.next as string });
        else {
          const server = { ...entry.next as Record<string, unknown>, name: entry.resource.key } as GlobalMcpServerConfig;
          if (entry.before === undefined) await this.mcp.add(server); else await this.mcp.update(server);
        }
        if (!deepEqual(await this.readResource(entry.resource), entry.next)) throw new Error('readback');
        result.items.push({ category: entry.category, key: entry.resource.key, status: 'applied' });
      } catch {
        let status: 'applied' | 'failed' | 'unverified' = 'unverified';
        try { const actual = await this.readResource(entry.resource); status = deepEqual(actual, entry.next) ? 'applied' : deepEqual(actual, entry.before) ? 'failed' : 'unverified'; } catch {}
        result.items.push({ category: entry.category, key: entry.resource.key, status });
        failure = 'writeFailed';
        break;
      }
    }
    if (failure === undefined && Object.keys(plan.sections).length > 0) {
      try {
        await this.config.replaceSections(plan.sections, ConfigTarget.User, plan.before);
        await this.config.reload();
        for (const [domain, value] of Object.entries(plan.sections)) {
          const matches = deepEqual(this.config.inspect(domain).userValue, value);
          recordConfigResult(result, domain, plan.before[domain], value, matches ? 'applied' : 'unverified');
          if (!matches) failure = 'readbackFailed';
        }
      } catch {
        failure = 'writeFailed';
        try { await this.config.reload(); } catch {}
        for (const [domain, value] of Object.entries(plan.sections)) {
          const actual = this.config.inspect(domain).userValue;
          recordConfigResult(result, domain, plan.before[domain], value, deepEqual(actual, value) ? 'applied' : deepEqual(actual, plan.before[domain]) ? 'failed' : 'unverified');
        }
      }
    }
    if (failure === undefined) for (const entry of plan.credentials) {
      if (!entry.write) continue;
      try {
        await this.searchCredentials.write(entry.resource, entry.before.version, entry.before.bindingVersion);
        result.items.push({ category: 'tools', key: entry.resource.key, status: 'applied' });
      } catch {
        let status: 'applied' | 'failed' | 'unverified' = 'unverified';
        try {
          const actual = await this.searchCredentials.inspect(this.config.get<NbSearchConfig | undefined>('nbSearch'), this.reuseLocalSearch(), entry.resource.key);
          status = actual.active && actual.value === entry.resource.value ? 'applied' : actual.version === entry.before.version ? 'failed' : 'unverified';
        } catch {}
        result.items.push({ category: 'tools', key: entry.resource.key, status });
        failure = 'writeFailed';
        break;
      }
    }
    const applied = result.items.some((item) => item.status === 'applied' || item.status === 'unverified');
    return { ...result, status: failure === undefined ? 'complete' : applied ? 'partial' : 'failed', failure };
  }

  private async globalMcp(): Promise<Map<string, McpRegistryEntry>> {
    return new Map((await this.mcpRegistry.list()).filter((entry) => entry.source === 'global').map((entry) => [entry.name, entry]));
  }

  private reuseLocalSearch(patch?: unknown): boolean {
    const source = mergeSelected(this.config.get('nbSearchSource'), patch ?? {}, 'overwrite');
    return isPlainObject(source) && typeof source['reuse_local_config'] === 'boolean' ? source['reuse_local_config'] : true;
  }

  private async readResource(resource: FileResource): Promise<unknown> {
    if (resource.kind === 'profile') return this.profiles.read(resource.key);
    const server = (await this.mcp.list()).find((entry) => entry.name === resource.key);
    if (server === undefined) return undefined;
    const { name: _name, ...entry } = server;
    return entry;
  }

  private validateDomain(domain: string, value: unknown): void {
    try {
      if (extraScalars.has(domain)) { if (typeof value !== 'string' || value.trim().length === 0) throw invalid(); }
      else this.registry.validate(domain, value);
      for (const validator of this.validators.items) if (validator.domain === domain) validator.validate(value);
      const diagnostics = this.registry.getSection(domain)?.collectDiagnostics?.(value) ?? [];
      if (diagnostics.some((entry) => entry.severity === 'error')) throw invalid();
    } catch { throw invalid(`configuration:${domain}`); }
  }

  private existingUnit(domain: string, path: readonly string[], own: unknown): unknown {
    if (own !== undefined) return own;
    const key = path.slice(1).join('.');
    const explicit = Object.entries(this.config.origins(domain)).some(([field, origin]) => origin !== 'default' && (field === key || field.startsWith(`${key}.`)));
    return explicit ? atPath({ [domain]: this.config.get(domain) }, path) : undefined;
  }

  private resourceKey(key: string): string { return this.bootstrap.platform === 'win32' ? key.toLowerCase() : key; }

  private validateModelLinks(sections: Record<string, unknown>): void {
    const providers = sections['providers'] === undefined ? this.config.get('providers') : mergeSelected(this.config.get('providers'), sections['providers'], 'overwrite');
    const models = sections['models'] === undefined ? this.config.get('models') : mergeSelected(this.config.get('models'), sections['models'], 'overwrite');
    if (isPlainObject(models)) {
      for (const model of Object.values(models)) {
        if (isPlainObject(model) && model['enabled'] !== false && typeof model['provider'] === 'string' && (!isPlainObject(providers) || providers[model['provider']] === undefined)) throw invalid('modelProvider');
      }
    }
  }
}

function invalid(reason = 'format'): Error2 { return new Error2(ErrorCodes.CONFIG_INVALID, `Invalid settings package (${reason}). Check its format, version, categories and configuration values.`); }
function safeParse<T>(schema: { parse(value: unknown): T }, value: unknown): T { try { return schema.parse(value); } catch { throw invalid(); } }
function assertSize(value: unknown): void { if (new TextEncoder().encode(JSON.stringify(value)).length > SETTINGS_TRANSFER_MAX_BYTES) throw invalid(); }
function summary(id: SettingsTransferCategory): SettingsTransferCategorySummary { return { id, items: 0, added: 0, conflicts: 0, unchanged: 0, skipped: 0 }; }
function resourceCategory(resource: SettingsTransferResource): SettingsTransferCategory { return resource.kind === 'profile' ? resource.category ?? 'agents' : 'tools'; }
function recordConfigResult(result: SettingsTransferApplyResult, domain: string, before: unknown, next: unknown, status: SettingsTransferApplyResult['items'][number]['status']): void {
  for (const unit of configUnits(domain, next)) {
    if (deepEqual(atPath({ [domain]: before }, unit.path), unit.value)) continue;
    result.items.push({ category: categoryForUnit(unit.path)!, key: unit.path.join('.'), status });
  }
}
function mcpInlineCredentials(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (unsafeUrl(value['url'])) return true;
  return Array.isArray(value['args']) && value['args'].some((arg) => typeof arg === 'string' && mcpCredentialArgument(arg));
}
function mcpCredentialArgument(arg: string): boolean {
  if (unsafeUrl(arg) || /(?:api[-_]?key|access[-_]?key|token|secret|password|authorization|bearer)(?:[\s:=]|$)/iu.test(arg)) return true;
  if (arg === '-H' || (arg.startsWith('-H') && /[:=]/u.test(arg.slice(2)))) return true;
  const flag = /^--?([^=\s]+)(?:=|$)/u.exec(arg)?.[1];
  if (flag === undefined) return false;
  const words = flag.replaceAll(/([a-z0-9])([A-Z])/gu, '$1-$2').replaceAll(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2').toLowerCase().split(/[-_]+/u);
  return words.some((word, index) => /^(?:auth|authorization|bearer|token|secret|password|headers?|credentials?|apikey|accesskey)$/u.test(word)
    || ((word === 'api' || word === 'access') && words[index + 1] === 'key'));
}
function promptReferences(value: unknown): readonly string[] {
  const refs = new Set<string>();
  const walk = (entry: unknown, overrides = false): void => {
    if (Array.isArray(entry)) { for (const child of entry) walk(child, overrides); return; }
    if (!isPlainObject(entry)) return;
    for (const [key, child] of Object.entries(entry)) {
      if (overrides && key === 'files' && Array.isArray(child)) {
        for (const ref of child) if (typeof ref === 'string') {
          try { refs.add(validatePromptOverridePath(ref)); } catch { throw invalid('referencedPromptFile'); }
        }
      }
      walk(child, overrides || ['promptOverrides', 'prompt_overrides', 'overrides'].includes(key));
    }
  };
  walk(value);
  return [...refs];
}

registerScopedService(LifecycleScope.App, ISettingsTransferService, SettingsTransferService, ScopeActivation.OnDemand, 'settingsTransfer');
