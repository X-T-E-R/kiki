import { createHash } from 'node:crypto';

import { join } from 'pathe';

import {
  PERSONA_ID_PATTERN,
  parsePersonaFileText,
  serializePersonaFile,
  type PersonaDefinition,
  type PersonaSnapshot,
} from '@kiki/agent-profiles/personaFile';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { TimeoutTimer } from '#/_base/utils/timer';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ILogService } from '#/_base/log/log';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { IHostFsWatchService, type HostFsChange } from '#/os/interface/hostFsWatch';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { detectCardFormat, exportPersonaCard, parsePersonaCard, personaCardBytes, type PersonaCardAsset } from './personaCard';
import {
  IPersonaStore,
  type PersonaAvatar,
  type PersonaAvatarInput,
  type PersonaAvatarMime,
  type PersonaAvatarShape,
  type PersonaCardFormat,
  type PersonaDeleteResult,
  type PersonaDuplicateOptions,
  type PersonaExport,
  type PersonaExportOptions,
  type PersonaImportInput,
  type PersonaImportPreview,
  type PersonaImportResult,
  type PersonaListOptions,
  type PersonaLifecycleHooks,
  type PersonaMemoryImportEntry,
  type PersonaMemoryHooks,
  type PersonaPutInput,
  type PersonaState,
  type PersonaStatePatch,
  type PersonaSummary,
} from './personaStore';

const MAX_PERSONA_BYTES = 1024 * 1024;
const MAX_EXAMPLES_BYTES = 256 * 1024;
const MAX_EXTENSIONS_BYTES = 256 * 1024;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const PERSONA_ROOT = 'personas';
const PERSONA_FILE = 'persona.md';
const EXAMPLES_FILE = 'examples.md';
const EXTENSIONS_FILE = 'extensions.json';
const AVATAR_META_FILE = 'avatar.json';
const AVATAR_KEYS: ReadonlySet<string> = new Set(['avatar.png', 'avatar.jpg', 'avatar.webp', AVATAR_META_FILE]);
const STATE_FILE = 'state.json';
const CATALOG_FILE = 'catalog.json';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type AvatarExtension = PersonaAvatar['extension'];

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>;

export class PersonaStore extends Disposable implements IPersonaStore {
  declare readonly _serviceBrand: undefined;

  private readonly changeEmitter = this._register(new Emitter<void>());
  private readonly externalChangeDebounce = this._register(new TimeoutTimer());
  private memoryHooks: PersonaMemoryHooks | undefined;
  private lifecycleHooks: PersonaLifecycleHooks | undefined;
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IMemoryStore private readonly memoryStore: IMemoryStore,
    @ILogService private readonly log: ILogService,
    @IHostFsWatchService fsWatch: IHostFsWatchService,
  ) {
    super();
    const watch = fsWatch.watch(join(bootstrap.homeDir, PERSONA_ROOT), { recursive: true });
    this._register(watch);
    this._register(watch.onDidChange((change) => this.onExternalChange(change)));
  }

  async get(id: string): Promise<PersonaSnapshot | undefined> {
    assertPersonaId(id);
    const raw = await this.readRaw(id, PERSONA_FILE, MAX_PERSONA_BYTES);
    if (raw === undefined) return undefined;
    const definition = parsePersonaFileText({ path: this.path(id, PERSONA_FILE), id, text: raw });
    const examples = await this.readRaw(id, EXAMPLES_FILE, MAX_EXAMPLES_BYTES);
    return {
      definition,
      revision: personaRevision(raw, examples),
      examples: examples === undefined || examples.length === 0 ? undefined : examples,
    };
  }

  async list(options: PersonaListOptions = {}): Promise<readonly PersonaSummary[]> {
    const catalog = await this.readCatalog();
    const names = new Set<string>([
      ...catalog,
      ...(await this.storage.list(PERSONA_ROOT)).filter((name) => name !== CATALOG_FILE),
    ]);
    const summaries: PersonaSummary[] = [];
    for (const name of names) {
      if (!PERSONA_ID_PATTERN.test(name)) continue;
      try {
        const snapshot = await this.get(name);
        if (snapshot === undefined) continue;
        const state = await this.readState(name);
        if (state.archived && options.includeArchived !== true) continue;
        const avatar = await this.findAvatar(name);
        summaries.push({
          id: name,
          name: snapshot.definition.name,
          title: snapshot.definition.title,
          job: snapshot.definition.job,
          revision: snapshot.revision,
          archived: state.archived,
          homeSessionId: state.homeSessionId,
          pinned: state.pinned === true,
          hidden: state.hidden === true,
          avatarMime: avatar?.mimeType,
          avatarShape: avatar === undefined ? undefined : await this.readAvatarShape(name),
        });
      } catch {
        continue;
      }
    }
    return summaries.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async put(input: PersonaPutInput | PersonaDefinition): Promise<PersonaSnapshot> {
    const normalized = normalizePutInput(input);
    const id = normalized.id ?? (normalized.definition.id || derivePersonaId(normalized.definition.name));
    assertPersonaId(id);
    const definition: PersonaDefinition = { ...normalized.definition, id };
    const personaText = serializePersonaFile(definition);
    this.validateDefinitionText(id, personaText);
    const extensionsText = normalized.extensions === undefined ? undefined : JSON.stringify(normalized.extensions, null, 2);
    if (extensionsText !== undefined) assertTextSize(EXTENSIONS_FILE, extensionsText, MAX_EXTENSIONS_BYTES);
    let examples: string | undefined;
    let before: ReadonlyMap<string, Uint8Array> | undefined;
    let mutated = false;
    try {
      await this.withLock(id, async () => {
        before = await this.snapshotFiles(id);
        const existingRaw = decodeOptional(before.get(PERSONA_FILE));
        const existingExamples = decodeOptional(before.get(EXAMPLES_FILE));
        if (normalized.createOnly === true && existingRaw !== undefined) throw new Error(`Persona already exists: ${id}`);
        if (normalized.expectedRevision !== undefined) {
          const currentRevision = existingRaw === undefined ? undefined : personaRevision(existingRaw, existingExamples);
          if (currentRevision !== normalized.expectedRevision) throw new Error(`Persona revision conflict for ${id}`);
        }
        examples = normalized.examplesProvided ? normalized.examples : existingExamples;
        if (examples !== undefined) assertTextSize(EXAMPLES_FILE, examples, MAX_EXAMPLES_BYTES);
        if (!normalized.extensionsProvided) await this.readJson(id, EXTENSIONS_FILE, MAX_EXTENSIONS_BYTES);
        mutated = true;
        await this.writeRaw(id, PERSONA_FILE, personaText);
        if (normalized.examplesProvided) {
          if (examples === undefined || examples.length === 0) await this.storage.delete(this.scope(id), EXAMPLES_FILE);
          else await this.writeRaw(id, EXAMPLES_FILE, examples);
        }
        if (normalized.extensionsProvided) {
          if (extensionsText === undefined) await this.storage.delete(this.scope(id), EXTENSIONS_FILE);
          else await this.writeRaw(id, EXTENSIONS_FILE, extensionsText);
        }
        await this.updateCatalog((ids) => [...new Set([...ids, id])]);
      });
    } catch (error) {
      if (mutated && before !== undefined) await this.restoreOrThrow(id, before, error);
      throw error;
    }
    const snapshot: PersonaSnapshot = { definition, revision: personaRevision(personaText, examples), examples: examples === undefined || examples.length === 0 ? undefined : examples };
    this.changeEmitter.fire();
    return snapshot;
  }

  async duplicate(id: string, options?: PersonaDuplicateOptions | string): Promise<PersonaSnapshot> {
    const source = await this.get(id);
    if (source === undefined) throw new Error(`Persona not found: ${id}`);
    const sourceExtensions = await this.readJson(id, EXTENSIONS_FILE, MAX_EXTENSIONS_BYTES);
    const requestedId = typeof options === 'string' ? options : options?.id;
    const targetId = await this.nextDuplicateId(requestedId ?? `${id}-copy`);
    const name = typeof options === 'object' && options?.name !== undefined ? options.name : `${source.definition.name} 副本`;
    const snapshot = await this.put({
      definition: { ...source.definition, id: targetId, name },
      createOnly: true,
      examples: source.examples,
      extensions: sourceExtensions,
    });
    const avatar = await this.getAvatar(id);
    if (avatar !== undefined) await this.putAvatar(targetId, avatar);
    return snapshot;
  }

  async archive(id: string, archived = true): Promise<PersonaState> {
    const state = await this.withLock(id, async () => {
      if (await this.get(id) === undefined) throw new Error(`Persona not found: ${id}`);
      const current = await this.readState(id);
      const patch = archived ? await this.lifecycleHooks?.beforeArchive(id, current, (patch) => this.writeJson(id, STATE_FILE, { ...current, ...patch }, 8 * 1024)) : undefined;
      const next = { ...current, ...patch, archived, version: 1 as const };
      await this.writeJson(id, STATE_FILE, next, 8 * 1024);
      return next;
    });
    this.changeEmitter.fire();
    return state;
  }

  setLifecycleHooks(hooks: PersonaLifecycleHooks | undefined): void {
    this.lifecycleHooks = hooks;
  }

  async claimHomeSession(id: string, sessionId: string, expectedHomeSessionId?: string): Promise<PersonaState> {
    const state = await this.withLock(id, async () => {
      if (await this.get(id) === undefined) throw new Error(`Persona not found: ${id}`);
      const current = await this.readState(id);
      if (current.homeSessionId !== expectedHomeSessionId || current.archived) return current;
      const next = { ...current, homeSessionId: sessionId };
      await this.writeJson(id, STATE_FILE, next, 8 * 1024);
      return next;
    });
    this.changeEmitter.fire();
    return state;
  }

  async getState(id: string): Promise<PersonaState> {
    assertPersonaId(id);
    if (await this.get(id) === undefined) throw new Error(`Persona not found: ${id}`);
    return this.readState(id);
  }

  async updateState(id: string, patch: PersonaStatePatch, validate?: (current: PersonaState) => Promise<void>): Promise<PersonaState> {
    assertPersonaId(id);
    if (await this.get(id) === undefined) throw new Error(`Persona not found: ${id}`);
    let state: PersonaState = { version: 1, archived: false };
    await this.withLock(id, async () => {
      const current = await this.readState(id);
      await validate?.(current);
      state = { ...current, ...patch, version: 1 };
      if (typeof state.archived !== 'boolean') throw new Error('Persona state archived must be a boolean');
      await this.writeJson(id, STATE_FILE, state, 8 * 1024);
    });
    this.changeEmitter.fire();
    return state;
  }

  async delete(id: string, expectedRevision?: string): Promise<PersonaDeleteResult> {
    assertPersonaId(id);
    return this.withLock(id, async () => {
      const keys = await this.storage.list(this.scope(id));
      if (keys.length === 0) return { memory: { status: 'committed' as const } };
      if (expectedRevision !== undefined) {
        const raw = await this.storage.read(this.scope(id), PERSONA_FILE, { recoverMissing: false });
        const examples = await this.storage.read(this.scope(id), EXAMPLES_FILE, { recoverMissing: false });
        const revision = raw === undefined ? undefined : personaRevision(textDecoder.decode(raw), decodeOptional(examples));
        if (expectedRevision !== revision) throw new Error(`Persona revision conflict for ${id}`);
      }
      await this.lifecycleHooks?.beforeDelete(id);
      const memory = await this.deleteMemory(id);
      if (memory.status !== 'committed') return { memory };
      for (const key of await this.storage.list(this.scope(id))) await this.storage.delete(this.scope(id), key);
      await this.updateCatalog((ids) => ids.filter((candidate) => candidate !== id));
      this.changeEmitter.fire();
      return { memory };
    });
  }

  async previewImport(input: PersonaImportInput): Promise<PersonaImportPreview> {
    return this.makeImportPreview(input, await parsePersonaCard(input, 'persona'));
  }

  async importCard(input: PersonaImportInput, options: { readonly id?: string } = {}): Promise<PersonaImportResult> {
    const parsed = await parsePersonaCard(input, 'persona');
    const preview = this.makeImportPreview(input, parsed);
    const id = options.id ?? preview.definition.id;
    const definition = { ...preview.definition, id };
    if (parsed.avatar !== undefined) {
      if (parsed.avatar.data.byteLength > MAX_AVATAR_BYTES) throw new Error('Avatar exceeds the 2 MiB size limit');
      await normalizeAvatar(parsed.avatar.data, detectAvatarMime(parsed.avatar.data, parsed.avatar.mimeType));
    }
    const personaText = serializePersonaFile(definition);
    this.validateDefinitionText(id, personaText);
    const examples = preview.examples;
    if (examples !== undefined) assertTextSize(EXAMPLES_FILE, examples, MAX_EXAMPLES_BYTES);
    const extensionsText = preview.extensions === undefined ? undefined : JSON.stringify(preview.extensions, null, 2);
    if (extensionsText !== undefined) assertTextSize(EXTENSIONS_FILE, extensionsText, MAX_EXTENSIONS_BYTES);
    let before: ReadonlyMap<string, Uint8Array> | undefined;
    let mutated = false;
    let memory: PersonaImportResult['memory'] = { status: 'committed', count: 0 };
    try {
      await this.withLock(id, async () => {
        before = await this.snapshotFiles(id);
        if (before.has(PERSONA_FILE)) throw new Error(`Persona already exists: ${id}`);
        mutated = true;
        await this.writeRaw(id, PERSONA_FILE, personaText);
        if (examples !== undefined && examples.length > 0) await this.writeRaw(id, EXAMPLES_FILE, examples);
        if (extensionsText !== undefined) await this.writeRaw(id, EXTENSIONS_FILE, extensionsText);
        await this.updateCatalog((ids) => [...new Set([...ids, id])]);
        if (parsed.avatar !== undefined) await this.writeAvatarUnlocked(id, parsed.avatar);
        if (parsed.assets !== undefined) await this.writeAssetsUnlocked(id, parsed.assets);
        memory = await this.importMemory(id, preview.memoryEntries);
        if (memory.status !== 'committed') throw new Error(memory.error ?? 'Persona memory import failed');
      });
    } catch (error) {
      let cleanupError: unknown;
      if (before?.size === 0) cleanupError = await this.cleanupImportedMemory(id);
      try {
        if (mutated && before !== undefined) await this.restoreOrThrow(id, before, error);
      } catch (rollbackError) {
        if (cleanupError !== undefined) {
          throw new Error('Persona rollback and memory cleanup both failed; persona directory may be inconsistent.', { cause: error });
        }
        throw rollbackError;
      }
      if (cleanupError !== undefined) {
        throw new Error('Persona memory cleanup failed; persona directory may be inconsistent.', { cause: error });
      }
      throw error;
    }
    this.changeEmitter.fire();
    return {
      snapshot: { definition, revision: personaRevision(personaText, examples), examples: examples === undefined || examples.length === 0 ? undefined : examples },
      memory,
    };
  }

  async exportCard(id: string, format: PersonaCardFormat, options: PersonaExportOptions = {}): Promise<PersonaExport> {
    const snapshot = await this.get(id);
    if (snapshot === undefined) throw new Error(`Persona not found: ${id}`);
    const avatar = await this.getAvatar(id);
    const extensions = await this.readJson(id, EXTENSIONS_FILE, MAX_EXTENSIONS_BYTES);
    const assets = await this.readAssets(id);
    const memoryEntries: PersonaMemoryImportEntry[] = [];
    const memoryScopes: string[] = [];
    if (options.includeMemory === true) {
      for (const entry of await this.memoryStore.listPersonaEntries(id)) {
        if (entry.status !== 'active') continue;
        memoryEntries.push({ title: entry.title, body: entry.body, pinned: entry.pinned, type: 'reference' });
        memoryScopes.push(memoryScopeLabel(entry.scope));
      }
    }
    const exported = await exportPersonaCard(format, snapshot.definition, snapshot.examples, avatar, extensions, memoryEntries, assets);
    return options.includeMemory === true
      ? { ...exported, memoryScopes: [...new Set(memoryScopes)].toSorted() }
      : exported;
  }

  async getAvatar(id: string): Promise<PersonaAvatar | undefined> {
    assertPersonaId(id);
    const found = await this.findAvatar(id);
    if (found === undefined) return undefined;
    if ((await this.storage.size(this.scope(id), found.key) ?? 0) > MAX_AVATAR_BYTES) {
      throw new Error('Avatar exceeds the 2 MiB size limit');
    }
    const data = await this.storage.read(this.scope(id), found.key, { recoverMissing: false });
    if (data === undefined) return undefined;
    const dimensions = await avatarDimensions(data, found.mimeType);
    return {
      data,
      mimeType: found.mimeType,
      extension: found.extension,
      width: dimensions.width,
      height: dimensions.height,
      shape: await this.readAvatarShape(id),
    };
  }

  async putAvatar(id: string, input: PersonaAvatarInput | Uint8Array): Promise<PersonaAvatar> {
    assertPersonaId(id);
    if (await this.get(id) === undefined) throw new Error(`Persona not found: ${id}`);
    const raw: PersonaAvatarInput = input instanceof Uint8Array ? { data: input } : input;
    if (raw.data.byteLength > MAX_AVATAR_BYTES) throw new Error('Avatar exceeds the 2 MiB size limit');
    if (raw.shape !== undefined && !isAvatarShape(raw.shape)) throw new Error('Avatar shape must be circle or square');
    const mimeType = detectAvatarMime(raw.data, raw.mimeType);
    const normalized: PersonaAvatar = { ...await normalizeAvatar(raw.data, mimeType), shape: raw.shape };
    if (normalized.data.byteLength > MAX_AVATAR_BYTES) throw new Error('Scaled avatar exceeds the 2 MiB size limit');
    let before: ReadonlyMap<string, Uint8Array> | undefined;
    let mutated = false;
    try {
      await this.withLock(id, async () => {
        if (await this.get(id) === undefined) throw new Error(`Persona not found: ${id}`);
        before = await this.snapshotFiles(id);
        mutated = true;
        await this.writeAvatarDataUnlocked(id, normalized);
      });
    } catch (error) {
      if (mutated && before !== undefined) await this.restoreOrThrow(id, before, error);
      throw error;
    }
    this.changeEmitter.fire();
    return normalized;
  }

  async deleteAvatar(id: string): Promise<boolean> {
    assertPersonaId(id);
    const removed = await this.withLock(id, async () => {
      if (await this.get(id) === undefined) throw new Error(`Persona not found: ${id}`);
      const before = await this.snapshotFiles(id);
      const keys = [...before.keys()].filter((key) => AVATAR_KEYS.has(key));
      try {
        for (const key of keys) await this.storage.delete(this.scope(id), key);
      } catch (error) {
        await this.restoreOrThrow(id, before, error);
        throw error;
      }
      return keys.some((key) => key !== AVATAR_META_FILE);
    });
    if (removed) this.changeEmitter.fire();
    return removed;
  }

  setMemoryHooks(hooks: PersonaMemoryHooks | undefined): void {
    this.memoryHooks = hooks;
  }

  private onExternalChange(_change: HostFsChange): void {
    this.externalChangeDebounce.cancelAndSet(() => this.changeEmitter.fire(), 100);
  }

  private makeImportPreview(
    input: PersonaImportInput,
    parsed: Awaited<ReturnType<typeof parsePersonaCard>>,
  ): PersonaImportPreview {
    const id = derivePersonaId(parsed.definition.name);
    return {
      format: detectCardFormat(personaCardBytes(input.data), input.format, input.filename),
      definition: { ...parsed.definition, id },
      examples: parsed.examples,
      avatar: parsed.avatar === undefined || parsed.avatarMimeType === undefined
        ? undefined
        : { mimeType: parsed.avatarMimeType, data: Buffer.from(parsed.avatar.data).toString('base64') },
      avatarMimeType: parsed.avatarMimeType,
      memoryEntries: parsed.memoryEntries,
      ignoredFields: parsed.ignoredFields,
      extensions: parsed.extensions,
    };
  }

  private validateDefinitionText(id: string, text: string): void {
    assertPersonaId(id);
    assertTextSize(PERSONA_FILE, text, MAX_PERSONA_BYTES);
    parsePersonaFileText({ path: this.path(id, PERSONA_FILE), id, text });
  }

  private async readRaw(id: string, key: string, limit: number): Promise<string | undefined> {
    const size = await this.storage.size(this.scope(id), key);
    if (size === undefined) return undefined;
    if (size > limit) throw new Error(`Persona file ${key} exceeds the size limit`);
    const bytes = await this.storage.read(this.scope(id), key, { recoverMissing: false });
    return bytes === undefined ? undefined : textDecoder.decode(bytes);
  }

  private async writeRaw(id: string, key: string, text: string): Promise<void> {
    await this.storage.write(this.scope(id), key, textEncoder.encode(text), { atomic: true });
  }

  private async readJson(id: string, key: string, limit: number): Promise<unknown | undefined> {
    const text = await this.readRaw(id, key, limit);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid ${key} for persona ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private async writeJson(id: string, key: string, value: unknown, limit: number): Promise<void> {
    const text = JSON.stringify(value, null, 2);
    assertTextSize(key, text, limit);
    await this.writeRaw(id, key, text);
  }

  private async snapshotFiles(id: string): Promise<ReadonlyMap<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    for (const key of await this.storage.list(this.scope(id))) {
      const data = await this.storage.read(this.scope(id), key, { recoverMissing: false });
      if (data !== undefined) files.set(key, data);
    }
    return files;
  }

  private async restoreFiles(id: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const scope = this.scope(id);
    for (const key of await this.storage.list(scope)) {
      if (!files.has(key)) await this.storage.delete(scope, key);
    }
    for (const [key, data] of files) await this.storage.write(scope, key, data, { atomic: true });
  }

  private async cleanupImportedMemory(id: string): Promise<unknown | undefined> {
    try {
      const result = await this.deleteMemory(id);
      if (result.status !== 'committed') throw new Error(result.error ?? 'memory cleanup failed');
      return undefined;
    } catch (error) {
      this.log.error('persona import memory cleanup failed; persona directory may be inconsistent', { id, error });
      return error;
    }
  }

  private async restoreOrThrow(id: string, files: ReadonlyMap<string, Uint8Array>, original: unknown): Promise<void> {
    try {
      await this.restoreFiles(id, files);
    } catch (rollbackError) {
      this.log.error('persona rollback failed; persona directory may be inconsistent', {
        id,
        originalError: original,
        rollbackError,
      });
      throw new Error('Persona rollback also failed; persona directory may be inconsistent.', { cause: original });
    }
  }

  private async writeAvatarUnlocked(id: string, input: PersonaAvatarInput): Promise<void> {
    const mimeType = detectAvatarMime(input.data, input.mimeType);
    const normalized = await normalizeAvatar(input.data, mimeType);
    await this.writeAvatarDataUnlocked(id, normalized);
  }

  private async writeAvatarDataUnlocked(id: string, normalized: PersonaAvatar): Promise<void> {
    for (const key of await this.storage.list(this.scope(id))) {
      if (AVATAR_KEYS.has(key)) await this.storage.delete(this.scope(id), key);
    }
    await this.storage.write(this.scope(id), `avatar.${normalized.extension}`, normalized.data, { atomic: true });
    if (normalized.shape !== undefined) await this.writeJson(id, AVATAR_META_FILE, { version: 1, shape: normalized.shape }, 1024);
  }

  private async readAvatarShape(id: string): Promise<PersonaAvatarShape | undefined> {
    try {
      const value = await this.readJson(id, AVATAR_META_FILE, 1024);
      return isRecord(value) && value['version'] === 1 && isAvatarShape(value['shape']) ? value['shape'] : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeAssetsUnlocked(id: string, assets: readonly PersonaCardAsset[]): Promise<void> {
    for (const asset of assets) {
      const name = normalizeAssetName(asset.name);
      if (name === undefined || name === 'assets/avatar.png' || name === 'assets/avatar.jpg' || name === 'assets/avatar.webp') continue;
      await this.storage.write(this.scope(id), name, asset.data, { atomic: true });
    }
  }

  private async writeAssets(id: string, assets: readonly PersonaCardAsset[]): Promise<void> {
    await this.withLock(id, () => this.writeAssetsUnlocked(id, assets));
  }

  private async readAssets(id: string): Promise<readonly PersonaCardAsset[]> {
    const assets: PersonaCardAsset[] = [];
    for (const key of await this.storage.list(this.scope(id), 'assets/')) {
      if (key.endsWith('/')) continue;
      const data = await this.storage.read(this.scope(id), key, { recoverMissing: false });
      if (data !== undefined) assets.push({ name: key, data });
    }
    return assets;
  }

  private async readCatalog(): Promise<readonly string[]> {
    const bytes = await this.storage.read(PERSONA_ROOT, CATALOG_FILE, { recoverMissing: false });
    if (bytes === undefined) return [];
    try {
      const value: unknown = JSON.parse(textDecoder.decode(bytes));
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is string => typeof item === 'string' && PERSONA_ID_PATTERN.test(item));
    } catch {
      return [];
    }
  }

  private async updateCatalog(update: (ids: readonly string[]) => readonly string[]): Promise<void> {
    const lock = await this.storage.acquireLock(PERSONA_ROOT, 'persona-catalog', { leaseMs: 30_000 });
    try {
      const ids = [...new Set(update(await this.readCatalog()))].filter((id) => PERSONA_ID_PATTERN.test(id)).toSorted();
      await this.storage.write(PERSONA_ROOT, CATALOG_FILE, textEncoder.encode(JSON.stringify(ids, null, 2)), { atomic: true });
    } finally {
      await lock.release();
    }
  }

  private async readState(id: string): Promise<PersonaState> {
    const value = await this.readJson(id, STATE_FILE, 8 * 1024);
    if (!isRecord(value) || value['version'] !== 1 || typeof value['archived'] !== 'boolean') return { version: 1, archived: false, pinned: false, hidden: false };
    return { ...value, pinned: value['pinned'] === true, hidden: value['hidden'] === true } as PersonaState;
  }

  private async findAvatar(id: string): Promise<{ readonly key: string; readonly mimeType: PersonaAvatarMime; readonly extension: AvatarExtension } | undefined> {
    const keys = await this.storage.list(this.scope(id));
    for (const extension of ['png', 'jpg', 'webp'] as const) {
      const key = `avatar.${extension}`;
      if (!keys.includes(key)) continue;
      return { key, extension, mimeType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` as PersonaAvatarMime };
    }
    return undefined;
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const lock = await this.storage.acquireLock(this.scope(id), 'persona-write', { leaseMs: 30_000 });
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  private scope(id: string): string {
    return `${PERSONA_ROOT}/${id}`;
  }

  private path(id: string, key: string): string {
    const root = this.bootstrap.homeDir;
    return `${root}/${this.scope(id)}/${key}`;
  }

  private async nextDuplicateId(base: string): Promise<string> {
    assertPersonaId(base);
    if (await this.get(base) === undefined) return base;
    for (let index = 2; index < 10_000; index++) {
      const candidate = `${base}-${index}`;
      if (await this.get(candidate) === undefined) return candidate;
    }
    throw new Error('Unable to allocate a duplicate persona id');
  }

  private async deleteMemory(id: string): Promise<PersonaDeleteResult['memory']> {
    try {
      if (this.memoryHooks === undefined) await this.memoryStore.deletePersonaNamespaces(id);
      else await this.memoryHooks.deletePersonaNamespaces(id);
      return { status: 'committed' };
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async importMemory(id: string, entries: readonly PersonaMemoryImportEntry[]): Promise<PersonaImportResult['memory']> {
    if (entries.length === 0) return { status: 'committed', count: 0 };
    try {
      if (this.memoryHooks === undefined) {
        await this.memoryStore.importLorebook(
          { kind: 'persona', personaId: id },
          entries.map((entry) => ({
            title: entry.title,
            content: entry.body,
            constant: entry.pinned,
            name: entry.title,
          })),
        );
      } else {
        await this.memoryHooks.importLorebook(id, entries);
      }
      return { status: 'committed', count: entries.length };
    } catch (error) {
      return {
        status: 'failed',
        count: entries.length,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

registerScopedService(LifecycleScope.App, IPersonaStore, PersonaStore, ScopeActivation.OnDemand, 'persona');

export function personaRevision(personaText: string, examples: string | undefined): string {
  return createHash('sha256').update(personaText).update('\0').update(examples ?? '').digest('hex');
}

function normalizeAssetName(name: string): string | undefined {
  const normalized = name.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized.startsWith('assets/') || normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
  return normalized;
}

function normalizePutInput(input: PersonaPutInput | PersonaDefinition): {
  readonly definition: PersonaDefinition;
  readonly id?: string;
  readonly expectedRevision?: string;
  readonly createOnly?: boolean;
  readonly examples?: string;
  readonly examplesProvided: boolean;
  readonly extensions?: unknown;
  readonly extensionsProvided: boolean;
} {
  if (isPersonaDefinition(input)) {
    return {
      definition: input,
      examples: undefined,
      examplesProvided: false,
      extensions: undefined,
      extensionsProvided: false,
    };
  }
  const source = input.definition ?? input;
  const definition: PersonaDefinition = {
    id: input.id ?? source.id ?? '',
    name: input.name ?? source.name ?? '',
    title: input.title ?? source.title,
    job: input.job ?? source.job,
    profile: input.profile ?? source.profile,
    modelAlias: input.modelAlias ?? source.modelAlias,
    thinkingEffort: input.thinkingEffort ?? source.thinkingEffort,
    greeting: input.greeting ?? source.greeting,
    greetings: input.greetings ?? source.greetings,
    roomGreeting: input.roomGreeting ?? source.roomGreeting,
    delivery: input.delivery ?? source.delivery,
    memory: input.memory ?? source.memory,
    skills: input.skills ?? source.skills,
    tags: input.tags ?? source.tags,
    notes: input.notes ?? source.notes,
    homeWorkspace: input.homeWorkspace ?? source.homeWorkspace,
    description: input.description ?? source.description ?? '',
  };
  return {
    definition,
    id: input.id,
    expectedRevision: input.expectedRevision,
    createOnly: input.createOnly,
    examples: input.examples,
    examplesProvided: Object.hasOwn(input, 'examples'),
    extensions: input.extensions,
    extensionsProvided: Object.hasOwn(input, 'extensions'),
  };
}

function isPersonaDefinition(input: PersonaPutInput | PersonaDefinition): input is PersonaDefinition {
  return 'description' in input && 'name' in input && !('definition' in input) && !('examples' in input) && !('extensions' in input) && !('expectedRevision' in input) && !('createOnly' in input);
}

function assertPersonaId(id: string): void {
  if (!PERSONA_ID_PATTERN.test(id)) throw new Error(`Invalid persona id "${id}"`);
}

function assertTextSize(key: string, text: string, limit: number): void {
  if (textEncoder.encode(text).byteLength > limit) throw new Error(`Persona file ${key} exceeds the size limit`);
}

function decodeOptional(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : textDecoder.decode(bytes);
}

function derivePersonaId(name: string): string {
  const ascii = name.normalize('NFKD').toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '');
  if (ascii.length > 0) return ascii.slice(0, 64);
  return `persona-${createHash('sha256').update(name).digest('hex').slice(0, 6)}`;
}

function detectAvatarMime(data: Uint8Array, requested: string | undefined): PersonaAvatarMime {
  const detected = data.length >= 8 && data.slice(0, 8).every((value, index) => value === Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)[index])
    ? 'image/png'
    : data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      ? 'image/jpeg'
      : data.length >= 12 && ascii(data, 0, 'RIFF') && ascii(data, 8, 'WEBP')
        ? 'image/webp'
        : undefined;
  const normalizedRequested = requested === 'image/jpg' ? 'image/jpeg' : requested;
  if (detected === undefined) throw new Error('Avatar is not a PNG, JPEG, or WebP image');
  if (normalizedRequested !== undefined && normalizedRequested !== detected) throw new Error('Avatar MIME type does not match its bytes');
  return detected;
}

async function normalizeAvatar(data: Uint8Array, mimeType: PersonaAvatarMime): Promise<PersonaAvatar> {
  const { width, height, image } = await decodeAvatar(data, mimeType);
  const longest = Math.max(width, height);
  let outputMime = mimeType;
  let output = data;
  if (longest > 256 || mimeType === 'image/png' || mimeType === 'image/jpeg') {
    if (longest > 256) {
      const factor = 256 / longest;
      image.resize({ w: Math.max(1, Math.round(width * factor)), h: Math.max(1, Math.round(height * factor)) });
    }
    if (mimeType === 'image/webp') outputMime = 'image/png';
    output = outputMime === 'image/jpeg'
      ? await image.getBuffer('image/jpeg', { quality: 90 })
      : await image.getBuffer('image/png', { deflateLevel: 9 });
  }
  const extension = outputMime === 'image/jpeg' ? 'jpg' : outputMime === 'image/webp' ? 'webp' : 'png';
  return { data: Uint8Array.from(output), mimeType: outputMime, extension, width: image.width, height: image.height };
}

async function decodeAvatar(data: Uint8Array, mimeType: PersonaAvatarMime): Promise<{ readonly image: JimpImage; readonly width: number; readonly height: number }> {
  const { Jimp } = await import('jimp');
  if (mimeType === 'image/webp') {
    const { decodeWebp } = await import('#/agent/media/webp-decode');
    const decoded = await decodeWebp(data);
    const image = await Jimp.fromBitmap({
      data: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height,
    });
    return { image, width: decoded.width, height: decoded.height };
  }
  const image = await Jimp.fromBuffer(Buffer.from(data));
  return { image, width: image.width, height: image.height };
}

async function avatarDimensions(data: Uint8Array, mimeType: PersonaAvatarMime): Promise<{ readonly width: number; readonly height: number }> {
  const result = await decodeAvatar(data, mimeType);
  return { width: result.width, height: result.height };
}

function isAvatarShape(value: unknown): value is PersonaAvatarShape {
  return value === 'circle' || value === 'square';
}

function ascii(data: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((char, index) => data[offset + index] === char.codePointAt(0));
}

function memoryScopeLabel(scope: { readonly kind: string; readonly workspaceId?: string }): string {
  return scope.kind === 'persona_workspace' && scope.workspaceId !== undefined
    ? `persona_workspace:${scope.workspaceId}`
    : scope.kind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
