/**
 * HostFileEditorController — one editable host-file buffer: load, debounce
 * autosave, manual/blur save, and external-change conflict detection.
 *
 * kap-server has NO host-file write endpoint (fs:content is read-only, and the
 * engine deliberately ships no unconfined-write service), so the write side is
 * injected: the desktop app writes through tauri-plugin-fs, the browser build
 * marks tabs non-editable instead. The read side doubles as the conflict
 * probe: before every save the controller re-reads the file and compares it
 * against the baseline (`savedText`) it loaded/wrote last — a mismatch means
 * someone else touched the file and the save parks on a conflict until the
 * user picks overwrite / reload.
 *
 * Framework-free (subscribe/getState like SessionController) so the save and
 * conflict state machines are testable without React; the component layer
 * subscribes via useSyncExternalStore.
 */

export type HostFileEditorStatus = 'loading' | 'error' | 'ready';

export interface HostFileEditorSnapshot {
  readonly status: HostFileEditorStatus;
  readonly error: string | undefined;
  /** Last known on-disk content (load or successful save baseline). */
  readonly savedText: string;
  /** Current buffer. */
  readonly draft: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** A save found the on-disk content diverged from the baseline. */
  readonly conflict: boolean;
  /** Loaded file exceeded the edit cap — view-only, never autosaves. */
  readonly oversized: boolean;
  /** Bumped whenever the buffer is replaced externally (load/reload) so the
   * editor view knows to reset its document. */
  readonly generation: number;
  readonly lastSavedAt: number | undefined;
}

export interface HostFileEditorOptions {
  readonly path: string;
  readonly readFile: (path: string) => Promise<string | { readonly text: string; readonly truncated: boolean }>;
  /** Absent → the buffer is view-only (no write channel on this runtime). */
  readonly writeFile?: (path: string, text: string) => Promise<void>;
  readonly autosaveMs?: number;
  /** Files larger than this are view-only (never write back a truncated buffer). */
  readonly maxChars?: number;
  /** Window blur / tab hide triggers a save of a dirty buffer. Pass undefined
   * to opt out (tests drive saves explicitly). */
  readonly events?: Pick<typeof window, 'addEventListener' | 'removeEventListener'>;
}

const DEFAULT_AUTOSAVE_MS = 5000;
const DEFAULT_MAX_CHARS = 512_000;

export class HostFileEditorController {
  private snapshot: HostFileEditorSnapshot = {
    status: 'loading',
    error: undefined,
    savedText: '',
    draft: '',
    dirty: false,
    saving: false,
    conflict: false,
    oversized: false,
    generation: 0,
    lastSavedAt: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private loadToken = 0;

  constructor(private readonly options: HostFileEditorOptions) {
    const events = options.events ?? (typeof window === 'undefined' ? undefined : window);
    events?.addEventListener('blur', this.handleBlur);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibility);
    }
  }

  get editable(): boolean {
    return this.options.writeFile !== undefined && !this.snapshot.oversized;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = (): HostFileEditorSnapshot => this.snapshot;

  async load(): Promise<void> {
    const token = ++this.loadToken;
    this.patch({ status: 'loading', error: undefined });
    try {
      const loaded = await this.options.readFile(this.options.path);
      if (this.disposed || token !== this.loadToken) return;
      const text = typeof loaded === 'string' ? loaded : loaded.text;
      const oversized = (typeof loaded !== 'string' && loaded.truncated) ||
        text.length > (this.options.maxChars ?? DEFAULT_MAX_CHARS);
      this.patch({
        status: 'ready',
        savedText: text,
        draft: text,
        dirty: false,
        conflict: false,
        oversized,
        generation: this.snapshot.generation + 1,
      });
    } catch (error) {
      if (this.disposed || token !== this.loadToken) return;
      this.patch({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** User edit: mark dirty and (re)arm the debounce autosave. */
  setDraft(text: string): void {
    if (this.snapshot.status !== 'ready' || this.disposed) return;
    if (text === this.snapshot.draft) return;
    const dirty = text !== this.snapshot.savedText;
    this.patch({ draft: text, dirty });
    this.clearAutosave();
    if (dirty) this.scheduleAutosave();
  }

  /**
   * Save the buffer. Guards: nothing dirty, a save in flight, a parked
   * conflict, or no write channel all no-op. The on-disk probe runs first —
   * a divergence parks the save on the conflict flag instead of clobbering.
   */
  async saveNow(): Promise<void> {
    const snap = this.snapshot;
    if (!snap.dirty || snap.saving || snap.conflict || !this.editable || this.disposed) return;
    const baseline = snap.savedText;
    const textToSave = snap.draft;
    this.clearAutosave();
    this.patch({ saving: true });
    try {
      const current = await this.options.readFile(this.options.path);
      if (this.disposed) return;
      if ((typeof current === 'string' ? current : current.text) !== baseline ||
          (typeof current !== 'string' && current.truncated)) {
        this.patch({ saving: false, conflict: true });
        return;
      }
      await this.options.writeFile!(this.options.path, textToSave);
      if (this.disposed) return;
      const dirty = this.snapshot.draft !== textToSave;
      this.patch({
        saving: false,
        savedText: textToSave,
        dirty,
        lastSavedAt: Date.now(),
      });
      if (dirty) this.scheduleAutosave();
    } catch (error) {
      if (this.disposed) return;
      this.patch({
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Conflict resolution: `overwrite` writes the buffer over the diverged file;
   * `reload` discards the buffer and re-reads; `cancel` keeps editing (the
   * conflict flag clears but the next save re-probes and re-parks).
   */
  async resolveConflict(action: 'overwrite' | 'reload' | 'cancel'): Promise<void> {
    if (!this.snapshot.conflict || this.disposed) return;
    if (action === 'cancel') {
      this.patch({ conflict: false });
      return;
    }
    if (action === 'reload') {
      this.patch({ conflict: false, status: 'loading' });
      await this.load();
      return;
    }
    // overwrite: the probe already ran — write unconditionally.
    const textToSave = this.snapshot.draft;
    this.clearAutosave();
    this.patch({ saving: true, conflict: false });
    try {
      await this.options.writeFile!(this.options.path, textToSave);
      if (this.disposed) return;
      const dirty = this.snapshot.draft !== textToSave;
      this.patch({
        saving: false,
        savedText: textToSave,
        dirty,
        lastSavedAt: Date.now(),
      });
      if (dirty) this.scheduleAutosave();
    } catch (error) {
      if (this.disposed) return;
      this.patch({
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Clear a transient save/load error notice. */
  dismissError(): void {
    if (this.snapshot.error !== undefined) this.patch({ error: undefined });
  }

  dispose(): void {
    this.disposed = true;
    this.clearAutosave();
    const events = this.options.events ?? (typeof window === 'undefined' ? undefined : window);
    events?.removeEventListener('blur', this.handleBlur);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
    this.listeners.clear();
  }

  private readonly handleBlur = () => {
    if (this.snapshot.dirty) void this.saveNow();
  };

  private readonly handleVisibility = () => {
    if (document.visibilityState === 'hidden' && this.snapshot.dirty) void this.saveNow();
  };

  private clearAutosave(): void {
    if (this.autosaveTimer !== undefined) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = undefined;
    }
  }

  private scheduleAutosave(): void {
    if (!this.editable || this.disposed || !this.snapshot.dirty || this.snapshot.conflict) return;
    this.clearAutosave();
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = undefined;
      void this.saveNow();
    }, this.options.autosaveMs ?? DEFAULT_AUTOSAVE_MS);
  }

  private patch(next: Partial<HostFileEditorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
}
