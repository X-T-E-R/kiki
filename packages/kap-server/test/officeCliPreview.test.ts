import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { IHostProcess, IHostProcessService } from '@kiki/agent-core-v2/os/interface/hostProcess';
import { officePageCount, officeScreenshotArgs, officeSheetNames, OfficePreviewCleanupError, runOfficeCli } from '../src/services/documentPreview/officeCliPreview';

function fakeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  let rejectWait: (error: Error) => void = () => {};
  const waitPromise = new Promise<number>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const kill = vi.fn(async () => { exitCode = -1; });
  const dispose = vi.fn(async (): Promise<void> => {});
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    pid: 4242,
    get exitCode() { return exitCode; },
    stdin,
    stdout,
    stderr,
    wait: () => waitPromise,
    kill,
    dispose,
  };
  return {
    proc,
    stdout,
    kill,
    dispose,
    exit: (code: number) => { exitCode = code; resolveWait(code); },
    fail: (error: Error) => { rejectWait(error); },
  };
}

function hostFor(proc: IHostProcess): Pick<IHostProcessService, 'spawn'> {
  return { spawn: vi.fn(async () => proc) };
}

describe('office preview command', () => {
  it('renders docx and pptx through the html path and crops xlsx without that flag', () => {
    expect(officeScreenshotArgs({ path: 'C:/docs/deck.pptx', out: 'C:/tmp/preview.png', extension: 'pptx', page: 2 })).toEqual([
      'view', 'C:/docs/deck.pptx', 'screenshot', '--out', 'C:/tmp/preview.png', '--render', 'html', '--page', '2',
    ]);
    expect(officeScreenshotArgs({ path: 'C:/docs/note.docx', out: 'C:/tmp/preview.png', extension: 'docx', page: 1 })).toContain('--render');
    const sheet = officeScreenshotArgs({ path: 'C:/docs/book.xlsx', out: 'C:/tmp/preview.png', extension: 'xlsx', page: 1, range: 'Sheet2!A1:Z50' });
    expect(sheet).toEqual(['view', 'C:/docs/book.xlsx', 'screenshot', '--out', 'C:/tmp/preview.png', '--range', 'Sheet2!A1:Z50']);
    expect(sheet).not.toContain('--render');
  });

  it('reads a slide count from stats json and sheet names from an outline', () => {
    const pptx = '{"success":true,"data":{"slides":3,"words":1}}';
    const docx = '{"success":true,"data":{"paragraphs":2,"words":4}}';
    expect(officePageCount(pptx, 'pptx')).toBe(3);
    expect(officePageCount(docx, 'docx')).toBeUndefined();
    expect(officePageCount('{"success":true,"data":{"sheets":1}}', 'xlsx')).toBeUndefined();
    expect(officeSheetNames('File: book.xlsx\n├── "Sheet1" (0 rows × 0 cols)\n└── "Totals" (1 rows × 1 cols)\n')).toEqual(['Sheet1', 'Totals']);
  });

  it('waits for owned-tree confirmation before settling cancel, timeout, or exit', async () => {
    const cancelled = fakeProcess();
    let releaseKill: () => void = () => {};
    cancelled.kill.mockImplementation(() => new Promise<void>((resolve) => { releaseKill = resolve; }));
    const host = hostFor(cancelled.proc);
    const controller = new AbortController();
    const pending = runOfficeCli('officecli.exe', ['view', 'deck.pptx', 'stats', '--json'], controller.signal, 60_000, host);
    controller.abort();
    await Promise.resolve();
    expect(cancelled.kill).toHaveBeenCalledTimes(1);
    expect(cancelled.dispose).not.toHaveBeenCalled();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(settled).toBe(false);
    releaseKill();
    await expect(pending).rejects.toThrow(/cancel/i);
    expect(cancelled.dispose).toHaveBeenCalledTimes(1);
    expect(host.spawn).toHaveBeenCalledWith('officecli.exe', ['view', 'deck.pptx', 'stats', '--json'], expect.objectContaining({
      ownedProcessTree: true,
      ownedProcessLifetime: 'process',
      windowsHide: true,
      env: expect.objectContaining({ OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_RESIDENT_FLUSH: 'each' }),
    }));

    const unclean = fakeProcess();
    const uncleanController = new AbortController();
    unclean.kill.mockRejectedValue(new Error('tree still active'));
    const uncleanRun = runOfficeCli('officecli.exe', ['view', 'deck.pptx', 'stats', '--json'], uncleanController.signal, 60_000, hostFor(unclean.proc));
    uncleanController.abort();
    await expect(uncleanRun).rejects.toBeInstanceOf(OfficePreviewCleanupError);
    expect(unclean.dispose).not.toHaveBeenCalled();

    const timed = fakeProcess();
    const timedRun = runOfficeCli('officecli.exe', ['view', 'deck.pptx', 'screenshot'], new AbortController().signal, 15, hostFor(timed.proc));
    await expect(timedRun).rejects.toThrow(/timed out/i);
    expect(timed.kill).toHaveBeenCalledTimes(1);
    expect(timed.dispose).toHaveBeenCalledTimes(1);

    const noisy = fakeProcess();
    const running = runOfficeCli('officecli.exe', ['view', 'deck.pptx', 'screenshot', '--render', 'html', '--page', '1'], new AbortController().signal, 60_000, hostFor(noisy.proc));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    noisy.stdout.write(Buffer.alloc(70 * 1024, 0x61));
    noisy.exit(0);
    const finished = await running;
    expect(finished.code).toBe(0);
    expect(finished.stdout.length).toBe(70 * 1024);
    expect(noisy.kill).not.toHaveBeenCalled();
    expect(noisy.dispose).toHaveBeenCalledTimes(1);

    const exitedRoot = fakeProcess();
    let releaseExitedKill: () => void = () => {};
    exitedRoot.kill.mockImplementation(() => new Promise<void>((resolve) => { releaseExitedKill = resolve; }));
    const exitedController = new AbortController();
    const exitedRun = runOfficeCli('officecli.exe', ['view', 'deck.pptx', 'screenshot', '--render', 'html', '--page', '1'], exitedController.signal, 60_000, hostFor(exitedRoot.proc));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    exitedRoot.exit(0);
    exitedController.abort();
    await Promise.resolve();
    expect(exitedRoot.proc.exitCode).toBe(0);
    expect(exitedRoot.kill).toHaveBeenCalledTimes(1);
    expect(exitedRoot.dispose).not.toHaveBeenCalled();
    let exitedSettled = false;
    void exitedRun.then(() => { exitedSettled = true; }, () => { exitedSettled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(exitedSettled).toBe(false);
    releaseExitedKill();
    await expect(exitedRun).rejects.toThrow(/cancel/i);
    expect(exitedRoot.dispose).toHaveBeenCalledTimes(1);

    const raced = fakeProcess();
    let releaseRaceKill: () => void = () => {};
    raced.kill.mockImplementation(() => new Promise<void>((resolve) => { releaseRaceKill = resolve; }));
    const raceController = new AbortController();
    const racedRun = runOfficeCli('officecli.exe', ['view', 'deck.pptx', 'screenshot', '--render', 'html', '--page', '1'], raceController.signal, 60_000, hostFor(raced.proc));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    raced.exit(0);
    await Promise.resolve();
    expect(raced.kill).not.toHaveBeenCalled();
    expect(raced.dispose).not.toHaveBeenCalled();
    raceController.abort();
    await Promise.resolve();
    expect(raced.proc.exitCode).toBe(0);
    expect(raced.kill).toHaveBeenCalledTimes(1);
    expect(raced.dispose).not.toHaveBeenCalled();
    let raceSettled = false;
    void racedRun.then(() => { raceSettled = true; }, () => { raceSettled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(raceSettled).toBe(false);
    releaseRaceKill();
    await expect(racedRun).rejects.toThrow(/cancel/i);
    expect(raced.dispose).toHaveBeenCalledTimes(1);

    const releasing = fakeProcess();
    let releaseDispose: () => void = () => {};
    releasing.dispose.mockImplementation(() => new Promise<void>((resolve) => { releaseDispose = resolve; }));
    const lateController = new AbortController();
    const releasedRun = runOfficeCli('officecli.exe', ['view', 'deck.pptx', 'stats', '--json'], lateController.signal, 60_000, hostFor(releasing.proc));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    releasing.exit(0);
    await vi.waitFor(() => { expect(releasing.dispose).toHaveBeenCalledTimes(1); });
    lateController.abort();
    releaseDispose();
    await expect(releasedRun).resolves.toMatchObject({ code: 0 });
    expect(releasing.kill).not.toHaveBeenCalled();

    const missing = runOfficeCli('officecli.exe', ['view', 'missing.pptx', 'stats', '--json'], new AbortController().signal, 60_000, {
      spawn: vi.fn(async () => { throw Object.assign(new Error('spawn failed'), { details: { errno: 'ENOENT' } }); }),
    });
    await expect(missing).resolves.toMatchObject({ spawnError: 'ENOENT', code: -1 });
  });
});
