/**
 * HostFileEditorController — one editable host-file buffer: load, opt-in edit,
 * debounce autosave, manual/blur save, and external-change conflict detection.
 *
 * kap-server has NO host-file write endpoint (fs:content is read-only, and the
 * engine deliberately ships no unconfined-write service), so the write side is
 * injected: the desktop app writes through tauri-plugin-fs, the browser build
 * marks tabs non-editable instead. Even on the local desktop, editing is
 * opt-in (`beginEdit()`) and allowed only when the bytes decoded losslessly as
 * UTF-8, the file was not truncated, and its type is a known text type.
 *
 * The read side doubles as the conflict probe: before every save the
 * controller re-reads the file and compares it against the baseline
 * (`savedText`) it loaded/wrote last — a mismatch means someone else touched
 * the file and the save parks on a conflict until the user picks overwrite /
 * reload.
 *
 * Framework-free (subscribe/getState like SessionController) so the save and
 * conflict state machines are testable without React; the component layer
 * subscribes via useSyncExternalStore.
 */

import { basenameOf } from '@kiki/session-core/composer/media';
import {
  classifyResource,
  type PreviewReadFailureReason,
} from './previewResource';

export type HostFileEditorStatus = 'loading' | 'error' | 'ready';

export interface HostFileReadResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly lossless?: boolean;
  readonly etag?: string;
  readonly notModified?: boolean;
}

export interface HostFileEditorSnapshot {
  readonly status: HostFileEditorStatus;
  readonly error: string | undefined;
  readonly failureReason: PreviewReadFailureReason | undefined;
  /** Last known on-disk content (load or successful save baseline). */
  readonly savedText: string;
  /** Current buffer. */
  readonly draft: string;
  /** Whether the user has explicitly entered edit mode for this tab. */
  readonly editing: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** A save found the on-disk content diverged from the baseline. */
  readonly conflict: boolean;
  /** Loaded file exceeded the edit cap — view-only, never autosaves. */
  readonly oversized: boolean;
  /** Whether the loaded bytes decoded losslessly as UTF-8 text. */
  readonly lossless: boolean;
  /** Last ETag reported by the host-file preview endpoint. */
  readonly etag: string | undefined;
  /** Bumped whenever the buffer is replaced externally (load/reload) so the
   * editor view knows to reset its document. */
  readonly generation: number;
  readonly lastSavedAt: number | undefined;
}

export interface HostFileEditorOptions {
  readonly path: string;
  readonly readFile: (
    path: string,
    options?: { readonly ifNoneMatch?: string },
  ) => Promise<string | HostFileReadResult>;
  /** Absent → the buffer is view-only (no write channel on this runtime). */
  readonly writeFile?: (path: string, text: string) => Promise<void>;
  /** True only when the GUI device is the computer running Kiki (fail-closed). */
  readonly local?: boolean;
  /** Override whether the file's type is a known text type; derived from `path` + UTF-8 bytes when omitted. */
  readonly knownTextType?: boolean;
  readonly autosaveMs?: number;
  /** Files larger than this are view-only (never write back a truncated buffer). */
  readonly maxChars?: number;
  /** Window blur / tab hide triggers a save of a dirty buffer. Pass undefined
   * to opt out (tests drive saves explicitly). */
  readonly events?: Pick<typeof window, 'addEventListener' | 'removeEventListener'>;
}

const DEFAULT_AUTOSAVE_MS = 5000;
const DEFAULT_MAX_CHARS = 512_000;
const utf8Encoder = new TextEncoder();

const EDITABLE_TEXT_TYPES = new Set(['text', 'markdown', 'html', 'table']);

/** Map a server / klient error from `fs:content` to a preview read-failure reason. */
export function classifyHostFileReadError(error: unknown): PreviewReadFailureReason {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly code?: unknown; readonly msg?: unknown; readonly message?: unknown };
    const code = typeof record.code === 'number' ? record.code : undefined;
    const message =
      typeof record.msg === 'string'
        ? record.msg
        : typeof record.message === 'string'
          ? record.message
          : '';
    if (code === 40409) return 'missing';
    if (code === 40411) return 'permission-denied';
    if (code === 40906) return 'folder';
    if (
      message === 'local_owner_required' ||
      message.includes('local_owner_required') ||
      message.includes('Operation is not available to a remote space')
    ) {
      return 'remote-unreadable';
    }
  }
  return 'error';
}

function isKnownTextPath(path: string, text: string, lossless: boolean): boolean {
  const name = basenameOf(path);
  const sampleHead = lossless
    ? utf8Encoder.encode(text.slice(0, 512))
    : new Uint8Array([0xff]);
  const resourceType = classifyResource({ name, head: sampleHead });
  return EDITABLE_TEXT_TYPES.has(resourceType);
}

export class HostFileEditorController {
  private snapshot: HostFileEditorSnapshot = {
    status: 'loading',
    error: undefined,
    failureReason: undefined,
    savedText: '',
    draft: '',
    editing: false,
    dirty: false,
    saving: false,
    conflict: false,
    oversized: false,
    lossless: true,
    etag: undefined,
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
    if (this.options.writeFile === undefined || this.options.local !== true) return false;
    if (this.snapshot.oversized || !this.snapshot.lossless) return false;
    if (this.options.knownTextType !== undefined) return this.options.knownTextType;
    return isKnownTextPath(this.options.path, this.snapshot.savedText, this.snapshot.lossless);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = (): HostFileEditorSnapshot => this.snapshot;

  async load(): Promise<void> {
    const token = ++this.loadToken;
    this.clearAutosave();
    this.patch({ status: 'loading', error: undefined, failureReason: undefined });
    try {
      const loaded = await this.options.readFile(this.options.path);
      if (this.disposed || token !== this.loadToken) return;
      const text = typeof loaded === 'string' ? loaded : loaded.text;
      const lossless = typeof loaded === 'string' ? true : loaded.lossless !== false;
      const etag = typeof loaded === 'string' ? undefined : loaded.etag;
      const oversized = (typeof loaded !== 'string' && loaded.truncated) ||
        text.length > (this.options.maxChars ?? DEFAULT_MAX_CHARS);
      const nextCanStayEditing =
        this.snapshot.editing &&
        this.options.writeFile !== undefined &&
        this.options.local === true &&
        !oversized &&
        lossless &&
        (this.options.knownTextType ?? isKnownTextPath(this.options.path, text, lossless));
      this.patch({
        status: 'ready',
        error: undefined,
        failureReason: undefined,
        savedText: text,
        draft: text,
        editing: nextCanStayEditing,
        dirty: false,
        conflict: false,
        oversized,
        lossless,
        etag,
        generation: this.snapshot.generation + 1,
      });
    } catch (error) {
      if (this.disposed || token !== this.loadToken) return;
      this.patch({
        status: 'error',
        editing: false,
        error: error instanceof Error ? error.message : String(error),
        failureReason: classifyHostFileReadError(error),
      });
    }
  }

  /** Re-read the file from disk, clearing any conflict or error notice. */
  async reload(): Promise<void> {
    this.clearAutosave();
    this.patch({ conflict: false });
    await this.load();
  }

  /** Enter edit mode explicitly. Succeeds only when the loaded file is safely editable. */
  beginEdit(): boolean {
    if (this.disposed || this.snapshot.status !== 'ready' || !this.editable) return false;
    if (!this.snapshot.editing) {
      this.patch({ editing: true });
      if (this.snapshot.dirty) this.scheduleAutosave();
    }
    return true;
  }

  /** User edit: mark dirty and (re)arm the debounce autosave only when editing. */
  setDraft(text: string): void {
    if (this.snapshot.status !== 'ready' || this.disposed) return;
    if (text === this.snapshot.draft) return;
    const dirty = text !== this.snapshot.savedText;
    this.patch({ draft: text, dirty });
    this.clearAutosave();
    if (dirty && this.snapshot.editing) this.scheduleAutosave();
  }

  /**
   * Save the buffer. Guards: not in edit mode, nothing dirty, a save in flight,
   * a parked conflict, or not editable all no-op. The on-disk probe runs first —
   * a divergence parks the save on the conflict flag instead of clobbering.
   */
  async saveNow(): Promise<void> {
    const snap = this.snapshot;
    if (!snap.editing || !snap.dirty || snap.saving || snap.conflict || !this.editable || this.disposed) return;
    const baseline = snap.savedText;
    const textToSave = snap.draft;
    this.clearAutosave();
    this.patch({ saving: true });
    try {
      const current = await this.options.readFile(this.options.path);
      if (this.disposed) return;
      if ((typeof current === 'string' ? current : current.text) !== baseline ||
          (typeof current !== 'string' && (current.truncated || current.lossless === false))) {
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
      await this.reload();
      return;
    }
    if (!this.snapshot.editing || !this.editable) return;
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
    if (this.snapshot.editing && this.snapshot.dirty) void this.saveNow();
  };

  private readonly handleVisibility = () => {
    if (document.visibilityState === 'hidden' && this.snapshot.editing && this.snapshot.dirty) {
      void this.saveNow();
    }
  };

  private clearAutosave(): void {
    if (this.autosaveTimer !== undefined) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = undefined;
    }
  }

  private scheduleAutosave(): void {
    if (!this.snapshot.editing || !this.editable || this.disposed || !this.snapshot.dirty || this.snapshot.conflict) return;
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
