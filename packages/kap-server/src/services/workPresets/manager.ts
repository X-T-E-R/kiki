import type { IAtomicDocumentStore, IPluginService, IPluginHostService } from '@kiki/agent-core-v2';
import { workPresetPreferenceSchema, type WorkPresetItem, type WorkPresetPreference, type WorkPresetMutationResponse } from '@kiki/protocol';

export interface PresetPluginSource { source: string; sha256?: string }
interface ModeRecord { enabled: boolean; removed: boolean; preferences: WorkPresetPreference }
const definitions = [
  { id: 'kiki', name: 'Kiki', description: 'General-purpose conversations and projects.', plugins: [] },
  { id: 'work', name: 'Work', description: 'Read office material, write and extract documents, and check tables.', plugins: [
    { id: 'kiki-office', name: 'Office', purpose: 'Create, inspect, edit and preview Word, Excel and PowerPoint files.', required: true, prerequisite: 'officecli' },
    { id: 'kiki-writing', name: 'Writing', purpose: 'Turn notes and source material into an editable draft.', required: true },
    { id: 'kiki-extract', name: 'Extract', purpose: 'Extract readable material from documents and web pages.', required: true },
    { id: 'kiki-work', name: 'Table checks', purpose: 'Compare CSV tables by key and report missing, changed and duplicate rows.', required: false },
  ] },
] as const;

export class WorkPresetManager {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly documents: Pick<IAtomicDocumentStore, 'get' | 'set'>,
    private readonly plugins: Pick<IPluginService, 'listPlugins' | 'previewPlugin' | 'installPlugin' | 'setPluginEnabled'>,
    private readonly host: Pick<IPluginHostService, 'installPrerequisite'>,
    private readonly sources: (published?: boolean) => Promise<ReadonlyMap<string, PresetPluginSource>>,
    readonly homeId: string,
  ) {}

  async list(): Promise<{ home_id: string; items: WorkPresetItem[] }> {
    const [saved, plugins, sources] = await Promise.all([this.saved(), this.plugins.listPlugins(), this.sources()]);
    return { home_id: this.homeId, items: definitions.map((definition) => {
      const record = saved[definition.id];
      return {
        id: definition.id, name: record?.preferences.name ?? definition.name,
        description: definition.description, enabled: definition.id === 'kiki' || record?.enabled === true,
        removed: record?.removed ?? false, preferences: record?.preferences ?? {},
        plugins: definition.plugins.map((dependency) => {
          const installed = plugins.find((plugin) => plugin.id === dependency.id);
          return { ...dependency, installed: installed !== undefined, enabled: installed?.enabled ?? false, available: installed !== undefined || sources.has(dependency.id) };
        }),
      };
    }) };
  }

  enable(id: string, prerequisites: boolean): Promise<WorkPresetMutationResponse> {
    return this.serialize(async () => {
      const definition = this.definition(id);
      const sources = await this.sources(true);
      const installed = new Map((await this.plugins.listPlugins()).map((plugin) => [plugin.id, plugin]));
      const completed: string[] = [];
      const failures: WorkPresetMutationResponse['failures'] = [];
      for (const dependency of definition.plugins) {
        try {
          let plugin = installed.get(dependency.id);
          if (plugin === undefined) {
            const source = sources.get(dependency.id);
            if (source === undefined) throw new Error('Package is not available from this installation source.');
            const plan = await this.plugins.previewPlugin(source);
            if (plan.id !== dependency.id) throw new Error('The package identity does not match the preset.');
            plugin = await this.plugins.installPlugin({ ...source, fingerprint: plan.fingerprint, consent: true });
            if (plugin.id !== dependency.id) throw new Error('The installed package identity does not match the preset.');
            installed.set(plugin.id, plugin);
          }
          if (!plugin.enabled) await this.plugins.setPluginEnabled({ id: plugin.id, enabled: true });
          completed.push(dependency.id);
          if (prerequisites && 'prerequisite' in dependency) {
            await this.host.installPrerequisite(dependency.id, dependency.prerequisite, true);
            completed.push(`${dependency.id}:${dependency.prerequisite}`);
          }
        } catch (error) {
          failures.push({ plugin_id: dependency.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
      const saved = await this.saved();
      saved[id] = { enabled: true, removed: false, preferences: saved[id]?.preferences ?? {} };
      await this.documents.set('work-presets', 'modes', saved);
      return { preset: await this.item(id), completed, failures };
    });
  }

  update(id: string, patch: { enabled?: boolean; preferences?: WorkPresetPreference }): Promise<WorkPresetMutationResponse> {
    return this.serialize(async () => {
      this.definition(id);
      if (id === 'kiki' && patch.enabled === false) throw new Error('The Kiki workspace remains available.');
      const saved = await this.saved();
      const current = saved[id] ?? { enabled: id === 'kiki', removed: false, preferences: {} };
      saved[id] = { enabled: patch.enabled ?? current.enabled, removed: current.removed, preferences: patch.preferences === undefined ? current.preferences : workPresetPreferenceSchema.parse({ ...current.preferences, ...patch.preferences }) };
      await this.documents.set('work-presets', 'modes', saved);
      return { preset: await this.item(id), completed: [], failures: [] };
    });
  }

  remove(id: string): Promise<WorkPresetMutationResponse> {
    return this.serialize(async () => {
      this.definition(id);
      if (id === 'kiki') throw new Error('The Kiki workspace cannot be removed.');
      const saved = await this.saved();
      saved[id] = { enabled: false, removed: true, preferences: saved[id]?.preferences ?? {} };
      await this.documents.set('work-presets', 'modes', saved);
      return { preset: await this.item(id), completed: [], failures: [] };
    });
  }

  private definition(id: string) {
    const definition = definitions.find((item) => item.id === id);
    if (definition === undefined) throw new Error(`Unknown work preset: ${id}`);
    return definition;
  }
  private async item(id: string): Promise<WorkPresetItem> { return (await this.list()).items.find((item) => item.id === id)!; }
  private async saved(): Promise<Record<string, ModeRecord>> { return await this.documents.get<Record<string, ModeRecord>>('work-presets', 'modes') ?? {}; }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work);
    this.writes = result.catch(() => undefined);
    return result;
  }
}
