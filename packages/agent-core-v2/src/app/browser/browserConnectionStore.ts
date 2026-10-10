import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';

import { BrowserError } from './errors';
import {
  BROWSER_CONFIG_SECTION, BrowserConfigSchema, BrowserConnectionInputSchema, BrowserIdSchema,
  browserConnectionRecord, type BrowserConfig, type BrowserConnectionInput, type BrowserConnectionRecord,
  type BrowserResolvedConnection, type BrowserStoredConnection,
} from './browserConfig';

export interface IBrowserConnectionStore {
  readonly _serviceBrand: undefined;
  list(): Promise<{ readonly connections: readonly BrowserConnectionRecord[]; readonly defaultBrowser?: string }>;
  resolve(id: string): Promise<BrowserResolvedConnection>;
  upsert(id: string, input: BrowserConnectionInput): Promise<BrowserConnectionRecord>;
  remove(id: string): Promise<void>;
  setDefault(browser?: string): Promise<void>;
  revealEndpoint(id: string): Promise<string | undefined>;
}
export const IBrowserConnectionStore = createDecorator<IBrowserConnectionStore>('browserConnectionStore');

export class BrowserConnectionStore implements IBrowserConnectionStore {
  declare readonly _serviceBrand: undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(@IConfigService private readonly config: IConfigService) {}

  async list(): Promise<{ readonly connections: readonly BrowserConnectionRecord[]; readonly defaultBrowser?: string }> {
    const current = await this.read();
    return { connections: Object.entries(current.connections).map(([id, entry]) => browserConnectionRecord({ ...entry, id }))
      .sort((a, b) => a.id.localeCompare(b.id)), defaultBrowser: current.defaultBrowser };
  }

  async resolve(id: string): Promise<BrowserResolvedConnection> {
    if (!BrowserIdSchema.safeParse(id).success) throw new BrowserError('browser.invalid', 'Invalid browser connection id');
    const connections = (await this.read()).connections;
    const entry = Object.hasOwn(connections, id) ? connections[id] : undefined;
    if (entry === undefined) throw new BrowserError('browser.not_found', `Unknown browser connection "${id}"`);
    return { ...entry, id };
  }

  async upsert(id: string, input: BrowserConnectionInput): Promise<BrowserConnectionRecord> {
    if (!BrowserIdSchema.safeParse(id).success) throw new BrowserError('browser.invalid', 'Invalid browser connection id');
    const parsed = BrowserConnectionInputSchema.safeParse(input);
    if (!parsed.success) throw new BrowserError('browser.invalid', 'Invalid browser connection configuration', { cause: parsed.error });
    await this.change((current) => {
      const value = parsed.data;
      let entry: BrowserStoredConnection;
      if (value.type !== 'agent-browser-cdp') entry = value;
      else {
        const previous = current.connections[id];
        const endpointSecret = value.endpoint.action === 'set' ? value.endpoint.value
          : previous?.type === 'agent-browser-cdp' ? previous.endpointSecret : undefined;
        if (endpointSecret === undefined) throw new BrowserError('browser.invalid', 'A CDP endpoint is required for a new connection');
        entry = { type: value.type, name: value.name, enabled: value.enabled, driverPath: value.driverPath, endpointSecret };
      }
      return { ...current, connections: { ...current.connections, [id]: entry } };
    });
    return browserConnectionRecord(await this.resolve(id));
  }

  async remove(id: string): Promise<void> {
    await this.resolve(id);
    await this.change((current) => {
      const connections = { ...current.connections };
      delete connections[id];
      return { connections, defaultBrowser: current.defaultBrowser === id ? undefined : current.defaultBrowser };
    });
  }

  async setDefault(browser?: string): Promise<void> {
    await this.change((current) => {
      if (browser !== undefined) {
        if (!BrowserIdSchema.safeParse(browser).success) throw new BrowserError('browser.invalid', 'Invalid browser connection id');
        const connection = Object.hasOwn(current.connections, browser) ? current.connections[browser] : undefined;
        if (connection === undefined) throw new BrowserError('browser.not_found', `Unknown browser connection "${browser}"`);
        if (!connection.enabled) throw new BrowserError('browser.disabled', `Browser connection "${browser}" is disabled`);
      }
      return { ...current, defaultBrowser: browser };
    });
  }

  async revealEndpoint(id: string): Promise<string | undefined> {
    const connection = await this.resolve(id);
    return connection.type === 'agent-browser-cdp' ? connection.endpointSecret : undefined;
  }

  private async read(): Promise<BrowserConfig> {
    await this.config.ready;
    return BrowserConfigSchema.parse(this.config.get(BROWSER_CONFIG_SECTION));
  }

  private change(update: (current: BrowserConfig) => BrowserConfig): Promise<void> {
    const result = this.tail.then(async () => {
      const previous = await this.read();
      const stored = this.config.inspect(BROWSER_CONFIG_SECTION).userValue;
      const expected = stored === undefined ? undefined : JSON.parse(JSON.stringify(stored));
      const next = JSON.parse(JSON.stringify(update(previous)));
      await this.config.replaceSections({ [BROWSER_CONFIG_SECTION]: next }, ConfigTarget.User, { [BROWSER_CONFIG_SECTION]: expected });
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

registerScopedService(LifecycleScope.App, IBrowserConnectionStore, BrowserConnectionStore, ScopeActivation.OnDemand, 'browser');
