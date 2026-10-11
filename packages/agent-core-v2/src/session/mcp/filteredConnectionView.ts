import type {
  McpConnectionView,
  McpServerEntry,
  McpStatusListener,
} from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { MCPClient } from '#/mcpCore/types';

export class FilteredMcpConnectionView implements McpConnectionView {
  private hidden: ReadonlySet<string>;
  private readonly sessionHidden = new Set<string>();
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
    return this.base.list().filter((entry) => !this.isHidden(entry.name));
  }

  get(name: string): McpServerEntry | undefined {
    return this.isHidden(name) ? undefined : this.base.get(name);
  }

  configOf(name: string): McpServerConfig | undefined {
    return this.isHidden(name) ? undefined : this.base.configOf(name);
  }

  resolved(name: string): ReturnType<McpConnectionView['resolved']> {
    return this.isHidden(name) ? undefined : this.base.resolved(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return this.isHidden(name) ? undefined : this.base.getRemoteServerUrl(name);
  }

  markNeedsAuth(name: string, error: unknown, client?: MCPClient): Promise<boolean> {
    return this.isHidden(name) ? Promise.resolve(false) : this.base.markNeedsAuth(name, error, client);
  }

  reconnect(name: string): Promise<void> {
    return this.isHidden(name) ? Promise.resolve() : this.base.reconnect(name);
  }

  connect(name: string, config: McpServerConfig): Promise<void> {
    return this.isHidden(name) || this.base.connect === undefined
      ? Promise.resolve()
      : this.base.connect(name, config);
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.isHidden(name) ? Promise.resolve() : this.base.reconnectAndJoin(name);
  }

  refreshToolList(name: string): Promise<void> {
    if (this.isHidden(name)) return Promise.resolve();
    return this.base.refreshToolList?.(name) ?? Promise.resolve();
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    return this.base.waitForInitialLoad(signal);
  }

  initialLoadDurationMs(): number {
    return this.base.initialLoadDurationMs();
  }

  setServerEnabled(name: string, enabled: boolean): boolean {
    const entry = this.base.get(name);
    if (entry === undefined && enabled) return false;
    const previous = this.isHidden(name);
    if (enabled) this.sessionHidden.delete(name);
    else this.sessionHidden.add(name);
    if (entry !== undefined) this.emitVisibilityChange(name, previous);
    return entry !== undefined;
  }

  clearServerOverride(name: string): boolean {
    const entry = this.base.get(name);
    if (entry === undefined && !this.sessionHidden.has(name)) return false;
    const previous = this.isHidden(name);
    this.sessionHidden.delete(name);
    if (entry !== undefined) this.emitVisibilityChange(name, previous);
    return previous;
  }

  isBaselineHidden(name: string): boolean {
    return this.hidden.has(name);
  }

  isSessionHidden(name: string): boolean {
    return this.sessionHidden.has(name);
  }

  replaceHidden(hidden: ReadonlySet<string>): void {
    const previous = this.hidden;
    const names = new Set([...previous, ...hidden]);
    this.hidden = hidden;
    for (const name of names) {
      this.emitVisibilityChange(name, previous.has(name) || this.sessionHidden.has(name));
    }
  }

  private isHidden(name: string): boolean {
    return this.sessionHidden.has(name) || this.hidden.has(name);
  }

  private emitVisibilityChange(name: string, wasHidden: boolean): void {
    const hidden = this.isHidden(name);
    if (wasHidden === hidden) return;
    const entry = this.base.get(name);
    if (entry === undefined) return;
    for (const listener of this.listeners) {
      listener(hidden ? { ...entry, status: 'disabled', toolCount: 0 } : entry);
    }
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    this.unsubscribe ??= this.base.onStatusChange((entry) => {
      if (!this.isHidden(entry.name)) {
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
