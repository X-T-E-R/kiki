import type {
  McpConnectionView,
  McpServerEntry,
  McpStatusListener,
} from '#/mcpCore/connection-manager';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { abortable } from '#/_base/utils/abort';

export class MergedMcpConnectionView implements McpConnectionView {
  private readonly sessionHidden = new Set<string>();
  private readonly sourceHidden = new Set<string>();
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
    return [...baseEntries, ...this.overlay.list()].filter((entry) => !this.isHidden(entry.name));
  }

  get(name: string): McpServerEntry | undefined {
    return this.isHidden(name) ? undefined : this.owner(name).get(name);
  }

  configOf(name: string): ReturnType<McpConnectionView['configOf']> {
    return this.isHidden(name) ? undefined : this.owner(name).configOf(name);
  }

  resolved(name: string): ReturnType<McpConnectionView['resolved']> {
    return this.isHidden(name) ? undefined : this.owner(name).resolved(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return this.isHidden(name) ? undefined : this.owner(name).getRemoteServerUrl(name);
  }

  markNeedsAuth(
    name: string,
    error: unknown,
    client?: import('#/mcpCore/types').MCPClient,
  ): Promise<boolean> {
    return this.isHidden(name)
      ? Promise.resolve(false)
      : this.owner(name).markNeedsAuth(name, error, client);
  }

  reconnect(name: string): Promise<void> {
    return this.isHidden(name) ? Promise.resolve() : this.owner(name).reconnect(name);
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.isHidden(name) ? Promise.resolve() : this.owner(name).reconnectAndJoin(name);
  }

  refreshToolList(name: string): Promise<void> {
    if (this.isHidden(name)) return Promise.resolve();
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
    const wasHidden = this.isHidden(name);
    if (enabled) this.sessionHidden.delete(name);
    else this.sessionHidden.add(name);
    if (entry !== undefined && wasHidden !== this.isHidden(name)) {
      const next = this.isHidden(name) ? { ...entry, status: 'disabled' as const, toolCount: 0 } : entry;
      this.emit(next);
    }
    return entry !== undefined;
  }

  clearServerOverride(name: string): boolean {
    const wasHidden = this.sessionHidden.delete(name);
    if (wasHidden && !this.isHidden(name)) {
      const entry = this.owner(name).get(name);
      if (entry !== undefined) this.emit(entry);
    }
    return wasHidden;
  }

  setSourceEnabled(name: string, enabled: boolean): void {
    const wasHidden = this.isHidden(name);
    if (enabled) this.sourceHidden.delete(name);
    else this.sourceHidden.add(name);
    if (wasHidden === this.isHidden(name)) return;
    const entry = this.owner(name).get(name);
    if (entry !== undefined) this.emit(this.isHidden(name) ? { ...entry, status: 'disabled', toolCount: 0 } : entry);
  }

  private isHidden(name: string): boolean {
    return this.sessionHidden.has(name) || this.sourceHidden.has(name);
  }

  replaceOverlayNames(names: ReadonlySet<string>): void {
    this.overlayNames = names;
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    const unsubscribeBase = this.base.onStatusChange((entry) => {
      if (!this.overlayNames.has(entry.name) && !this.isHidden(entry.name)) {
        listener(entry);
      }
    });
    const unsubscribeOverlay = this.overlay.onStatusChange((entry) => {
      if (!this.isHidden(entry.name)) listener(entry);
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
