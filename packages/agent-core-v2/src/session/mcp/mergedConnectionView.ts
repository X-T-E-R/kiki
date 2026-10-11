import type {
  McpConnectionView,
  McpServerEntry,
  McpStatusListener,
} from '#/mcpCore/connection-manager';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { abortable } from '#/_base/utils/abort';

export class MergedMcpConnectionView implements McpConnectionView {
  private readonly sessionHidden = new Set<string>();
  private readonly listeners = new Set<McpStatusListener>();

  constructor(
    private readonly base: McpConnectionView,
    private readonly overlay: McpConnectionView,
    private overlayNames: ReadonlySet<string>,
  ) {}

  get oauthService(): McpOAuthService | undefined {
    return this.overlay.oauthService ?? this.base.oauthService;
  }

  list(): readonly McpServerEntry[] {
    const baseEntries = this.base.list().filter((entry) => !this.overlayNames.has(entry.name));
    return [...baseEntries, ...this.overlay.list()].filter((entry) => !this.sessionHidden.has(entry.name));
  }

  get(name: string): McpServerEntry | undefined {
    return this.sessionHidden.has(name) ? undefined : this.owner(name).get(name);
  }

  configOf(name: string): ReturnType<McpConnectionView['configOf']> {
    return this.sessionHidden.has(name) ? undefined : this.owner(name).configOf(name);
  }

  resolved(name: string): ReturnType<McpConnectionView['resolved']> {
    return this.sessionHidden.has(name) ? undefined : this.owner(name).resolved(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return this.sessionHidden.has(name) ? undefined : this.owner(name).getRemoteServerUrl(name);
  }

  markNeedsAuth(
    name: string,
    error: unknown,
    client?: import('#/mcpCore/types').MCPClient,
  ): Promise<boolean> {
    return this.sessionHidden.has(name)
      ? Promise.resolve(false)
      : this.owner(name).markNeedsAuth(name, error, client);
  }

  reconnect(name: string): Promise<void> {
    return this.sessionHidden.has(name) ? Promise.resolve() : this.owner(name).reconnect(name);
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.sessionHidden.has(name) ? Promise.resolve() : this.owner(name).reconnectAndJoin(name);
  }

  refreshToolList(name: string): Promise<void> {
    if (this.sessionHidden.has(name)) return Promise.resolve();
    return this.owner(name).refreshToolList?.(name) ?? Promise.resolve();
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const both = Promise.all([
      this.base.waitForInitialLoad(),
      this.overlay.waitForInitialLoad(),
    ]).then(() => undefined);
    return signal === undefined ? both : abortable(both, signal);
  }

  initialLoadDurationMs(): number {
    return Math.max(this.base.initialLoadDurationMs(), this.overlay.initialLoadDurationMs());
  }

  setServerEnabled(name: string, enabled: boolean): boolean {
    const entry = this.owner(name).get(name);
    if (entry === undefined && enabled) return false;
    const wasHidden = this.sessionHidden.has(name);
    if (enabled) this.sessionHidden.delete(name);
    else this.sessionHidden.add(name);
    if (entry !== undefined && wasHidden !== this.sessionHidden.has(name)) {
      const next = this.sessionHidden.has(name) ? { ...entry, status: 'disabled' as const, toolCount: 0 } : entry;
      this.emit(next);
    }
    return entry !== undefined;
  }

  clearServerOverride(name: string): boolean {
    const entry = this.owner(name).get(name);
    if (entry === undefined && !this.sessionHidden.has(name)) return false;
    const wasHidden = this.sessionHidden.delete(name);
    if (wasHidden && entry !== undefined) this.emit(entry);
    return wasHidden;
  }

  replaceOverlayNames(names: ReadonlySet<string>): void {
    this.overlayNames = names;
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    const unsubscribeBase = this.base.onStatusChange((entry) => {
      if (entry.status !== 'removed' && !this.overlayNames.has(entry.name) && !this.sessionHidden.has(entry.name)) {
        listener(entry);
      }
    });
    const unsubscribeOverlay = this.overlay.onStatusChange((entry) => {
      if (entry.status !== 'removed' && !this.sessionHidden.has(entry.name)) listener(entry);
    });
    return () => {
      this.listeners.delete(listener);
      unsubscribeBase();
      unsubscribeOverlay();
    };
  }

  private emit(entry: McpServerEntry): void {
    for (const listener of this.listeners) listener(entry);
  }

  private owner(name: string): McpConnectionView {
    return this.overlayNames.has(name) ? this.overlay : this.base;
  }
}
