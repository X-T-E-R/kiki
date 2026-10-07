import type {
  McpConnectionView,
  McpServerEntry,
  McpStatusListener,
} from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { MCPClient } from '#/mcpCore/types';

export class FilteredMcpConnectionView implements McpConnectionView {
  private hidden: ReadonlySet<string>;
  private readonly listeners = new Set<McpStatusListener>();
  private unsubscribe?: () => void;

  constructor(
    private readonly base: McpConnectionView,
    hidden: ReadonlySet<string>,
  ) {
    this.hidden = hidden;
  }

  get oauthService() {
    return this.base.oauthService;
  }

  list(): readonly McpServerEntry[] {
    return this.base.list().filter((entry) => !this.hidden.has(entry.name));
  }

  get(name: string): McpServerEntry | undefined {
    return this.hidden.has(name) ? undefined : this.base.get(name);
  }

  configOf(name: string): McpServerConfig | undefined {
    return this.hidden.has(name) ? undefined : this.base.configOf(name);
  }

  resolved(name: string): ReturnType<McpConnectionView['resolved']> {
    return this.hidden.has(name) ? undefined : this.base.resolved(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return this.hidden.has(name) ? undefined : this.base.getRemoteServerUrl(name);
  }

  markNeedsAuth(name: string, error: unknown, client?: MCPClient): Promise<boolean> {
    return this.hidden.has(name) ? Promise.resolve(false) : this.base.markNeedsAuth(name, error, client);
  }

  reconnect(name: string): Promise<void> {
    return this.hidden.has(name) ? Promise.resolve() : this.base.reconnect(name);
  }

  connect(name: string, config: McpServerConfig): Promise<void> {
    return this.hidden.has(name) || this.base.connect === undefined
      ? Promise.resolve()
      : this.base.connect(name, config);
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.hidden.has(name) ? Promise.resolve() : this.base.reconnectAndJoin(name);
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    return this.base.waitForInitialLoad(signal);
  }

  initialLoadDurationMs(): number {
    return this.base.initialLoadDurationMs();
  }

  replaceHidden(hidden: ReadonlySet<string>): void {
    const previous = this.hidden;
    this.hidden = hidden;
    const names = new Set([...previous, ...hidden]);
    for (const name of names) {
      if (previous.has(name) === hidden.has(name)) continue;
      const entry = this.base.get(name);
      if (entry === undefined) continue;
      for (const listener of this.listeners) {
        listener(hidden.has(name) ? { ...entry, status: 'disabled', toolCount: 0 } : entry);
      }
    }
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    this.unsubscribe ??= this.base.onStatusChange((entry) => {
      if (!this.hidden.has(entry.name)) {
        for (const current of this.listeners) current(entry);
      }
    });
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    };
  }
}
