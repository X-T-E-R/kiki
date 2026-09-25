// @vitest-environment jsdom

/**
 * HostFileEditorController state machine: load → dirty → (debounced / manual /
 * blur) save, with the pre-save on-disk probe parking diverged files on the
 * conflict flag until the user resolves it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostFileEditorController } from './hostFileEditor';

function makeController(overrides?: {
  disk?: string;
  writeFile?: (path: string, text: string) => Promise<void>;
  autosaveMs?: number;
  maxChars?: number;
  events?: Pick<typeof window, 'addEventListener' | 'removeEventListener'>;
}) {
  const disk = { content: overrides?.disk ?? 'original' };
  const writes: string[] = [];
  const controller = new HostFileEditorController({
    path: '/work/file.ts',
    readFile: vi.fn(async () => disk.content),
    writeFile:
      overrides?.writeFile ??
      vi.fn(async (_path: string, text: string) => {
        writes.push(text);
        disk.content = text;
      }),
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
  });

  it('loads the file into the baseline and buffer', async () => {
    const { controller } = makeController();
    expect(controller.getState().status).toBe('loading');
    await controller.load();
    const snap = controller.getState();
    expect(snap.status).toBe('ready');
    expect(snap.savedText).toBe('original');
    expect(snap.draft).toBe('original');
    expect(snap.dirty).toBe(false);
    controller.dispose();
  });

  it('surfaces load failures', async () => {
    const controller = new HostFileEditorController({
      path: '/missing',
      readFile: async () => {
        throw new Error('nope');
      },
      writeFile: async () => {},
      events: { addEventListener: () => {}, removeEventListener: () => {} },
    });
    await controller.load();
    expect(controller.getState().status).toBe('error');
    expect(controller.getState().error).toBe('nope');
    controller.dispose();
  });

  it('autosaves 5s after the last edit (debounced)', async () => {
    const { controller, writes } = makeController();
    await controller.load();
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

  it('saves on window blur while dirty', async () => {
    const { controller, writes } = makeController({ events: window });
    await controller.load();
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
      readFile: async () => disk.content,
      events: { addEventListener: () => {}, removeEventListener: () => {} },
    });
    await controller.load();
    expect(controller.editable).toBe(false);
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
    controller.dispose();
  });

  it('never writes a byte-range-truncated preview even when its text is short', async () => {
    const writeFile = vi.fn(async () => {});
    const controller = new HostFileEditorController({
      path: '/work/file.ts',
      readFile: async () => ({ text: '中', truncated: true }),
      writeFile,
    });
    await controller.load();
    expect(controller.getState().oversized).toBe(true);
    expect(controller.editable).toBe(false);
    controller.setDraft('edit');
    await controller.saveNow();
    expect(writeFile).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('parks the save on conflict when the file changed on disk', async () => {
    const { controller, disk, writes } = makeController();
    await controller.load();
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

  it('conflict cancel keeps editing; the next save re-probes and re-parks', async () => {
    const { controller, disk, writes } = makeController();
    await controller.load();
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
