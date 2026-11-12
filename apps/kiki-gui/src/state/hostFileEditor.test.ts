// @vitest-environment jsdom

/**
 * HostFileEditorController state machine: load → opt-in beginEdit → dirty →
 * (debounced / manual / blur / visibility) save, with the pre-save on-disk
 * probe parking diverged files on the conflict flag until the user resolves it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostFileEditorController, type HostFileReadResult } from './hostFileEditor';

function makeController(overrides?: {
  path?: string;
  disk?: string;
  readFile?: (path: string, options?: { ifNoneMatch?: string }) => Promise<string | HostFileReadResult>;
  writeFile?: (path: string, text: string) => Promise<void>;
  local?: boolean;
  knownTextType?: boolean;
  autosaveMs?: number;
  maxChars?: number;
  events?: Pick<typeof window, 'addEventListener' | 'removeEventListener'>;
}) {
  const disk = { content: overrides?.disk ?? 'original' };
  const writes: string[] = [];
  const controller = new HostFileEditorController({
    path: overrides?.path ?? '/work/file.ts',
    readFile: overrides?.readFile ?? vi.fn(async () => disk.content),
    writeFile:
      overrides?.writeFile ??
      vi.fn(async (_path: string, text: string) => {
        writes.push(text);
        disk.content = text;
      }),
    local: overrides?.local ?? true,
    knownTextType: overrides?.knownTextType,
    autosaveMs: overrides?.autosaveMs ?? 5000,
    maxChars: overrides?.maxChars,
    events: overrides?.events,
  });
  return { controller, disk, writes };
}

describe('HostFileEditorController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  it('loads the file into the baseline and buffer in read-only mode (editing: false)', async () => {
    const { controller } = makeController();
    expect(controller.getState().status).toBe('loading');
    await controller.load();
    const snap = controller.getState();
    expect(snap.status).toBe('ready');
    expect(snap.savedText).toBe('original');
    expect(snap.draft).toBe('original');
    expect(snap.editing).toBe(false);
    expect(snap.dirty).toBe(false);
    expect(controller.editable).toBe(true);
    controller.dispose();
  });

  it('never writes before beginEdit(), even with a dirty buffer, timer expiry, blur, and visibility change', async () => {
    const { controller, writes } = makeController({ events: window });
    await controller.load();
    expect(controller.getState().editing).toBe(false);

    controller.setDraft('accidental keystroke');
    expect(controller.getState().dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toEqual([]);

    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([]);

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([]);

    await controller.saveNow();
    expect(writes).toEqual([]);
    controller.dispose();
  });

  it('rejects beginEdit() for lossless: false, truncated read, unknown type, and local: false', async () => {
    const nonUtf8 = makeController({
      readFile: async () => ({ text: '\ufffd\ufffd', truncated: false, lossless: false }),
    });
    await nonUtf8.controller.load();
    expect(nonUtf8.controller.editable).toBe(false);
    expect(nonUtf8.controller.beginEdit()).toBe(false);
    expect(nonUtf8.controller.getState().editing).toBe(false);
    nonUtf8.controller.dispose();

    const truncated = makeController({
      readFile: async () => ({ text: 'short slice', truncated: true, lossless: true }),
    });
    await truncated.controller.load();
    expect(truncated.controller.editable).toBe(false);
    expect(truncated.controller.beginEdit()).toBe(false);
    truncated.controller.dispose();

    const unknownExtensionless = makeController({
      path: '/work/compiled-binary',
      readFile: async () => ({ text: 'some ascii', truncated: false, lossless: true }),
    });
    await unknownExtensionless.controller.load();
    expect(unknownExtensionless.controller.editable).toBe(false);
    expect(unknownExtensionless.controller.beginEdit()).toBe(false);
    unknownExtensionless.controller.dispose();

    const knownExtensionless = makeController({
      path: '/work/Makefile',
      readFile: async () => ({ text: 'all:\n\techo ok\n', truncated: false, lossless: true }),
    });
    await knownExtensionless.controller.load();
    expect(knownExtensionless.controller.editable).toBe(true);
    expect(knownExtensionless.controller.beginEdit()).toBe(true);
    knownExtensionless.controller.dispose();

    const remoteSpace = makeController({ local: false });
    await remoteSpace.controller.load();
    expect(remoteSpace.controller.editable).toBe(false);
    expect(remoteSpace.controller.beginEdit()).toBe(false);
    remoteSpace.controller.dispose();
  });

  it('surfaces load failures and classifies server error codes', async () => {
    const cases: Array<{ err: unknown; expected: string }> = [
      { err: Object.assign(new Error('not found'), { code: 40409 }), expected: 'missing' },
      { err: Object.assign(new Error('denied'), { code: 40411 }), expected: 'permission-denied' },
      { err: Object.assign(new Error('dir'), { code: 40906 }), expected: 'folder' },
      { err: Object.assign(new Error('local_owner_required'), { code: 40101 }), expected: 'remote-unreadable' },
      { err: new Error('Operation is not available to a remote space'), expected: 'remote-unreadable' },
      { err: new Error('nope'), expected: 'error' },
    ];
    for (const item of cases) {
      const controller = new HostFileEditorController({
        path: '/missing.ts',
        local: true,
        readFile: async () => {
          throw item.err;
        },
        writeFile: async () => {},
        events: { addEventListener: () => {}, removeEventListener: () => {} },
      });
      await controller.load();
      expect(controller.getState().status).toBe('error');
      expect(controller.getState().failureReason).toBe(item.expected);
      controller.dispose();
    }
  });

  it('autosaves 5s after the last edit once beginEdit() is called', async () => {
    const { controller, writes } = makeController();
    await controller.load();
    expect(controller.beginEdit()).toBe(true);
    controller.setDraft('edit one');
    controller.setDraft('edit two');
    expect(controller.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(4999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(['edit two']);
    expect(controller.getState().dirty).toBe(false);
    expect(controller.getState().lastSavedAt).toBeTypeOf('number');
    controller.dispose();
  });

  it('manual save flushes immediately and cancels the pending debounce', async () => {
    const { controller, writes } = makeController();
    await controller.load();
    controller.beginEdit();
    controller.setDraft('typed');
    await controller.saveNow();
    expect(writes).toEqual(['typed']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toEqual(['typed']);
    controller.dispose();
  });

  it('keeps edits made during a save dirty and persists them in a follow-up save', async () => {
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    let writeCount = 0;
    let diskRef!: { content: string };
    let writesRef!: string[];
    const fixture = makeController({
      autosaveMs: 1000,
      writeFile: async (_path, text) => {
        writesRef.push(text);
        writeCount += 1;
        if (writeCount === 1) {
          signalWriteStarted();
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
        }
        diskRef.content = text;
      },
    });
    diskRef = fixture.disk;
    writesRef = fixture.writes;
    const { controller, disk, writes } = fixture;
    await controller.load();
    controller.beginEdit();
    controller.setDraft('first edit');
    const firstSave = controller.saveNow();
    await writeStarted;
    controller.setDraft('second edit');
    releaseWrite();
    await firstSave;

    expect(controller.getState()).toMatchObject({
      savedText: 'first edit',
      draft: 'second edit',
      dirty: true,
      saving: false,
    });
    expect(disk.content).toBe('first edit');

    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual(['first edit', 'second edit']);
    expect(controller.getState()).toMatchObject({
      savedText: 'second edit',
      dirty: false,
      saving: false,
    });
    controller.dispose();
  });

  it('saves on window blur while editing and dirty', async () => {
    const { controller, writes } = makeController({ events: window });
    await controller.load();
    controller.beginEdit();
    controller.setDraft('blurred');
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['blurred']);
    controller.dispose();
  });

  it('without a write channel the buffer is view-only and never autosaves', async () => {
    const disk = { content: 'original' };
    const controller = new HostFileEditorController({
      path: '/work/file.ts',
      local: true,
      readFile: async () => disk.content,
      events: { addEventListener: () => {}, removeEventListener: () => {} },
    });
    await controller.load();
    expect(controller.editable).toBe(false);
    expect(controller.beginEdit()).toBe(false);
    controller.setDraft('typed');
    expect(controller.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(disk.content).toBe('original');
    await controller.saveNow();
    expect(disk.content).toBe('original');
    controller.dispose();
  });

  it('oversized files are view-only', async () => {
    const { controller } = makeController({ disk: 'x'.repeat(100), maxChars: 10 });
    await controller.load();
    expect(controller.getState().oversized).toBe(true);
    expect(controller.editable).toBe(false);
    expect(controller.beginEdit()).toBe(false);
    controller.dispose();
  });

  it('never writes a byte-range-truncated preview even when its text is short', async () => {
    const writeFile = vi.fn(async () => {});
    const controller = new HostFileEditorController({
      path: '/work/file.ts',
      local: true,
      readFile: async () => ({ text: '中', truncated: true }),
      writeFile,
    });
    await controller.load();
    expect(controller.getState().oversized).toBe(true);
    expect(controller.editable).toBe(false);
    expect(controller.beginEdit()).toBe(false);
    controller.setDraft('edit');
    await controller.saveNow();
    expect(writeFile).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('parks the save on conflict when the file changed on disk', async () => {
    const { controller, disk, writes } = makeController();
    await controller.load();
    controller.beginEdit();
    controller.setDraft('mine');
    disk.content = 'someone else';
    await controller.saveNow();
    const snap = controller.getState();
    expect(snap.conflict).toBe(true);
    expect(snap.dirty).toBe(true);
    expect(writes).toEqual([]);
    controller.dispose();
  });

  it('conflict overwrite writes the buffer and re-baselines', async () => {
    const { controller, disk, writes } = makeController();
    await controller.load();
    controller.beginEdit();
    controller.setDraft('mine');
    disk.content = 'someone else';
    await controller.saveNow();
    await controller.resolveConflict('overwrite');
    expect(writes).toEqual(['mine']);
    expect(controller.getState().dirty).toBe(false);
    expect(controller.getState().conflict).toBe(false);
    expect(controller.getState().savedText).toBe('mine');
    controller.dispose();
  });

  it('conflict reload discards the buffer and bumps the generation', async () => {
    const { controller, disk } = makeController();
    await controller.load();
    controller.beginEdit();
    const generation = controller.getState().generation;
    controller.setDraft('mine');
    disk.content = 'someone else';
    await controller.saveNow();
    await controller.resolveConflict('reload');
    const snap = controller.getState();
    expect(snap.draft).toBe('someone else');
    expect(snap.savedText).toBe('someone else');
    expect(snap.dirty).toBe(false);
    expect(snap.generation).toBe(generation + 1);
    controller.dispose();
  });

  it('reload() re-reads from disk and updates etag and generation', async () => {
    let rev = 1;
    const { controller } = makeController({
      readFile: async () => ({
        text: `v${rev}`,
        truncated: false,
        lossless: true,
        etag: `"etag-${rev}"`,
      }),
    });
    await controller.load();
    expect(controller.getState().etag).toBe('"etag-1"');
    rev = 2;
    await controller.reload();
    expect(controller.getState().draft).toBe('v2');
    expect(controller.getState().etag).toBe('"etag-2"');
    controller.dispose();
  });

  it('checkDiskChange() sends If-None-Match, ignores 304, marks changedOnDisk when clean, and marks conflict when dirty (#32)', async () => {
    let etag = '"v1"';
    let text = 'initial';
    const seenIfNoneMatch: (string | undefined)[] = [];
    const { controller } = makeController({
      readFile: async (_path, options) => {
        seenIfNoneMatch.push(options?.ifNoneMatch);
        if (options?.ifNoneMatch !== undefined && options.ifNoneMatch === etag) {
          return { text: '', truncated: false, lossless: true, etag, notModified: true };
        }
        return { text, truncated: false, lossless: true, etag };
      },
    });
    await controller.load();
    expect(seenIfNoneMatch).toEqual([undefined]);

    // 304 Not Modified -> nothing changes
    await controller.checkDiskChange();
    expect(seenIfNoneMatch).toEqual([undefined, '"v1"']);
    expect(controller.getState().changedOnDisk).toBe(false);
    expect(controller.getState().conflict).toBe(false);

    // ETag changes while clean -> changedOnDisk without swapping draft
    etag = '"v2"';
    text = 'updated externally';
    await controller.checkDiskChange();
    expect(controller.getState().changedOnDisk).toBe(true);
    expect(controller.getState().draft).toBe('initial');

    // Reload swaps in the new text and clears changedOnDisk
    await controller.reload();
    expect(controller.getState().changedOnDisk).toBe(false);
    expect(controller.getState().draft).toBe('updated externally');
    expect(controller.getState().etag).toBe('"v2"');

    // ETag changes while dirty -> enters conflict choice instead of changedOnDisk
    controller.beginEdit();
    controller.setDraft('my local edit');
    etag = '"v3"';
    text = 'third external edit';
    await controller.checkDiskChange();
    expect(controller.getState().conflict).toBe(true);
    expect(controller.getState().changedOnDisk).toBe(false);
    expect(controller.getState().draft).toBe('my local edit');
    controller.dispose();
  });

  it('conflict cancel keeps editing; the next save re-probes and re-parks', async () => {
    const { controller, disk, writes } = makeController();
    await controller.load();
    controller.beginEdit();
    controller.setDraft('mine');
    disk.content = 'someone else';
    await controller.saveNow();
    await controller.resolveConflict('cancel');
    expect(controller.getState().conflict).toBe(false);
    expect(controller.getState().dirty).toBe(true);
    await controller.saveNow();
    expect(controller.getState().conflict).toBe(true);
    expect(writes).toEqual([]);
    controller.dispose();
  });

  it('editing back to the baseline clears the dirty flag', async () => {
    const { controller } = makeController();
    await controller.load();
    controller.beginEdit();
    controller.setDraft('typed');
    expect(controller.getState().dirty).toBe(true);
    controller.setDraft('original');
    expect(controller.getState().dirty).toBe(false);
    controller.dispose();
  });

  it('ignores stale loads after a newer load started', async () => {
    let resolveFirst!: (text: string) => void;
    let call = 0;
    const controller = new HostFileEditorController({
      path: '/work/file.ts',
      local: true,
      readFile: () =>
        new Promise<string>((resolve) => {
          call += 1;
          if (call === 1) resolveFirst = resolve;
          else resolve('fresh');
        }),
      writeFile: async () => {},
      events: { addEventListener: () => {}, removeEventListener: () => {} },
    });
    const first = controller.load();
    const second = controller.load();
    resolveFirst('stale');
    await Promise.all([first, second]);
    expect(controller.getState().draft).toBe('fresh');
    controller.dispose();
  });
});
