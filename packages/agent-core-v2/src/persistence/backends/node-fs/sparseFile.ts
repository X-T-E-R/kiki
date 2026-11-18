import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { stat, utimes } from 'node:fs/promises';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export const SPARSE_UNIT_BYTES = 64 * 1024;
export const DEFAULT_KEEP_HEAD_BYTES = 64 * 1024;
const PROTECTED_BOUNDARY_BYTES = 4 * 1024;
const WORKER_IDLE_TIMEOUT_MS = 2_000;

export interface SparseRange {
  readonly start: number;
  readonly end: number;
}

export interface SparsePunchResult {
  readonly supported: boolean;
  readonly punchedRanges: readonly SparseRange[];
  readonly allocatedBytesBefore?: number;
  readonly allocatedBytesAfter?: number;
}

export type SavedFileTimes =
  | {
      readonly kind: 'win32';
      readonly creationTime: string;
      readonly lastAccessTime: string;
      readonly lastWriteTime: string;
      readonly changeTime: string;
    }
  | {
      readonly kind: 'posix';
      readonly atime: Date;
      readonly mtime: Date;
    };

export function mergeSparseRanges(ranges: readonly SparseRange[]): SparseRange[] {
  const valid = ranges
    .filter((range) => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start)
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: SparseRange[] = [];
  for (const range of valid) {
    const last = merged.at(-1);
    if (last === undefined || range.start > last.end) {
      merged.push({ start: range.start, end: range.end });
    } else if (range.end > last.end) {
      merged[merged.length - 1] = { start: last.start, end: range.end };
    }
  }
  return merged;
}

export function planSparseRanges(
  sealedCut: number,
  keepHeadBytes = DEFAULT_KEEP_HEAD_BYTES,
  preserveOffsets: readonly number[] = [],
): SparseRange[] {
  if (!Number.isSafeInteger(sealedCut) || sealedCut <= 0) return [];
  const headFloor = Math.max(SPARSE_UNIT_BYTES, Math.ceil(Math.max(0, keepHeadBytes) / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES);
  const cutCeil = Math.floor(sealedCut / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES;
  if (cutCeil <= headFloor) return [];
  let intervals: SparseRange[] = [{ start: headFloor, end: cutCeil }];
  for (const offset of preserveOffsets) {
    if (!Number.isSafeInteger(offset) || offset <= 0) continue;
    const windowStart = Math.max(0, offset - PROTECTED_BOUNDARY_BYTES);
    const keepStart = Math.floor(windowStart / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES;
    const keepEnd = Math.ceil(offset / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES;
    const next: SparseRange[] = [];
    for (const interval of intervals) {
      if (keepEnd <= interval.start || keepStart >= interval.end) {
        next.push(interval);
        continue;
      }
      if (keepStart > interval.start) next.push({ start: interval.start, end: keepStart });
      if (keepEnd < interval.end) next.push({ start: keepEnd, end: interval.end });
    }
    intervals = next;
    if (intervals.length === 0) break;
  }
  return mergeSparseRanges(intervals);
}

const WIN32_SPARSE_POWERSHELL = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using Microsoft.Win32.SafeHandles;',
  'public static class KikiSparseNative {',
  '  private const uint GENERIC_READ = 0x80000000;',
  '  private const uint GENERIC_WRITE = 0x40000000;',
  '  private const uint FILE_READ_ATTRIBUTES = 0x00000080;',
  '  private const uint FILE_SHARE_ALL = 7;',
  '  private const uint OPEN_EXISTING = 3;',
  '  private const uint FILE_ATTRIBUTE_NORMAL = 0x80;',
  '  private const uint FSCTL_SET_SPARSE = 0x000900c4;',
  '  private const uint FSCTL_SET_ZERO_DATA = 0x000980c8;',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct FILE_ZERO_DATA_INFORMATION { public long FileOffset; public long BeyondFinalZero; }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct FILE_BASIC_INFO {',
  '    public long CreationTime;',
  '    public long LastAccessTime;',
  '    public long LastWriteTime;',
  '    public long ChangeTime;',
  '    public uint FileAttributes;',
  '  }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct FILE_SET_SPARSE_BUFFER { public byte SetSparse; }',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern SafeFileHandle CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  private static extern bool DeviceIoControl(SafeFileHandle hDevice, uint dwIoControlCode, IntPtr lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  private static extern bool DeviceIoControl(SafeFileHandle hDevice, uint dwIoControlCode, ref FILE_ZERO_DATA_INFORMATION lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  private static extern bool DeviceIoControl(SafeFileHandle hDevice, uint dwIoControlCode, ref FILE_SET_SPARSE_BUFFER lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  private static extern bool GetFileInformationByHandleEx(SafeFileHandle hFile, int infoClass, out FILE_BASIC_INFO lpFileInformation, uint dwBufferSize);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  private static extern bool SetFileInformationByHandle(SafeFileHandle hFile, int infoClass, ref FILE_BASIC_INFO lpFileInformation, uint dwBufferSize);',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  private static extern bool FlushFileBuffers(SafeFileHandle hFile);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);',
  '  public static long AllocatedBytes(string path) {',
  '    uint high;',
  '    uint low = GetCompressedFileSizeW(path, out high);',
  '    if (low == 0xFFFFFFFF) {',
  '      int err = Marshal.GetLastWin32Error();',
  '      if (err != 0) throw new System.ComponentModel.Win32Exception(err);',
  '    }',
  '    return ((long)high << 32) | (long)low;',
  '  }',
  '  public static string GetTimes(string path) {',
  '    using (SafeFileHandle h = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero)) {',
  '      if (h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
  '      FILE_BASIC_INFO info;',
  '      if (!GetFileInformationByHandleEx(h, 0, out info, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) {',
  '        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
  '      }',
  '      return info.CreationTime + "\\t" + info.LastAccessTime + "\\t" + info.LastWriteTime + "\\t" + info.ChangeTime;',
  '    }',
  '  }',
  '  public static void RestoreDenseAndTimes(string path, long cTime, long aTime, long wTime, long chTime) {',
  '    using (SafeFileHandle h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero)) {',
  '      if (h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
  '      uint ret;',
  '      FILE_SET_SPARSE_BUFFER clearBuf = new FILE_SET_SPARSE_BUFFER { SetSparse = 0 };',
  '      DeviceIoControl(h, FSCTL_SET_SPARSE, ref clearBuf, 1, IntPtr.Zero, 0, out ret, IntPtr.Zero);',
  '      FlushFileBuffers(h);',
  '      FILE_BASIC_INFO cur;',
  '      if (GetFileInformationByHandleEx(h, 0, out cur, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) {',
  '        cur.CreationTime = cTime;',
  '        cur.LastAccessTime = aTime;',
  '        cur.LastWriteTime = wTime;',
  '        cur.ChangeTime = chTime;',
  '        SetFileInformationByHandle(h, 0, ref cur, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)));',
  '      }',
  '    }',
  '  }',
  '  public static string PunchRanges(string path, string spec) {',
  '    long before = AllocatedBytes(path);',
  '    using (SafeFileHandle h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero)) {',
  '      if (h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
  '      FILE_BASIC_INFO saved;',
  '      bool hasSaved = GetFileInformationByHandleEx(h, 0, out saved, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)));',
  '      uint ret;',
  '      if (!DeviceIoControl(h, FSCTL_SET_SPARSE, IntPtr.Zero, 0, IntPtr.Zero, 0, out ret, IntPtr.Zero)) {',
  '        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
  '      }',
  '      foreach (string item in spec.Split(\',\')) {',
  '        if (string.IsNullOrEmpty(item)) continue;',
  '        string[] bounds = item.Split(\':\');',
  '        FILE_ZERO_DATA_INFORMATION z = new FILE_ZERO_DATA_INFORMATION { FileOffset = long.Parse(bounds[0]), BeyondFinalZero = long.Parse(bounds[1]) };',
  '        if (!DeviceIoControl(h, FSCTL_SET_ZERO_DATA, ref z, (uint)Marshal.SizeOf(typeof(FILE_ZERO_DATA_INFORMATION)), IntPtr.Zero, 0, out ret, IntPtr.Zero)) {',
  '          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
  '        }',
  '      }',
  '      FlushFileBuffers(h);',
  '      if (hasSaved) {',
  '        FILE_BASIC_INFO cur;',
  '        if (GetFileInformationByHandleEx(h, 0, out cur, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) {',
  '          saved.FileAttributes = cur.FileAttributes;',
  '          SetFileInformationByHandle(h, 0, ref saved, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)));',
  '        }',
  '      }',
  '    }',
  '    long after = AllocatedBytes(path);',
  '    return before + "\\t" + after;',
  '  }',
  '}',
  "'@",
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'while (($line = [Console]::In.ReadLine()) -ne $null) {',
  '  if ($line.Length -eq 0) { continue }',
  '  try {',
  '    $parts = $line.Split([char]9)',
  '    $path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($parts[1]))',
  "    if ($parts[0] -eq 'size') {",
  '      [Console]::Out.WriteLine("ok`t" + [KikiSparseNative]::AllocatedBytes($path))',
  "    } elseif ($parts[0] -eq 'gettimes') {",
  '      [Console]::Out.WriteLine("ok`t" + [KikiSparseNative]::GetTimes($path))',
  "    } elseif ($parts[0] -eq 'settimes') {",
  '      [KikiSparseNative]::RestoreDenseAndTimes($path, [int64]$parts[2], [int64]$parts[3], [int64]$parts[4], [int64]$parts[5])',
  '      [Console]::Out.WriteLine("ok`t0")',
  "    } elseif ($parts[0] -eq 'punch') {",
  '      [Console]::Out.WriteLine("ok`t" + [KikiSparseNative]::PunchRanges($path, $parts[2]))',
  '    } else {',
  '      [Console]::Out.WriteLine("err`tunknown command")',
  '    }',
  '  } catch {',
  '    $msg = $_.Exception.Message.Replace("`r", " ").Replace("`n", " ")',
  '    [Console]::Out.WriteLine("err`t" + $msg)',
  '  }',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

interface Win32SparseWorker {
  readonly proc: ChildProcessByStdio<Writable, Readable, null>;
  readonly rl: ReadlineInterface;
  readonly nextLine: () => Promise<string>;
}

let activeWorker: Win32SparseWorker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let workerQueue: Promise<void> = Promise.resolve();
let pendingCommands = 0;
let exitHookRegistered = false;

export function closeSparseFileWorker(): void {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  const current = activeWorker;
  activeWorker = undefined;
  if (current === undefined) return;
  try {
    current.rl.close();
  } catch {}
  try {
    current.proc.stdin.end();
  } catch {}
  try {
    current.proc.kill();
  } catch {}
}

function armIdleClose(): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    closeSparseFileWorker();
  }, WORKER_IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function ensureWin32Worker(): Win32SparseWorker {
  if (activeWorker !== undefined && activeWorker.proc.exitCode === null && !activeWorker.proc.killed) {
    return activeWorker;
  }
  closeSparseFileWorker();
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once('exit', () => closeSparseFileWorker());
  }
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN32_SPARSE_POWERSHELL], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  proc.unref();
  (proc.stdin as unknown as { unref?: () => void }).unref?.();
  (proc.stdout as unknown as { unref?: () => void }).unref?.();
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const buffered: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(line);
    else buffered.push(line);
  });
  const failAll = (error: Error): void => {
    if (activeWorker?.proc === proc) activeWorker = undefined;
    while (waiters.length > 0) waiters.shift()!.reject(error);
  };
  proc.once('error', (error) => failAll(error instanceof Error ? error : new Error(String(error))));
  proc.once('close', (code) => failAll(new Error(`win32 sparse helper exited (${String(code)})`)));
  const worker: Win32SparseWorker = {
    proc,
    rl,
    nextLine: () => {
      if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
      return new Promise<string>((resolvePromise, rejectPromise) => {
        waiters.push({ resolve: resolvePromise, reject: rejectPromise });
      });
    },
  };
  activeWorker = worker;
  return worker;
}

function setWorkerRef(worker: Win32SparseWorker, referenced: boolean): void {
  const stdoutHandle = worker.proc.stdout as unknown as { ref?: () => void; unref?: () => void };
  if (referenced) {
    worker.proc.ref();
    stdoutHandle.ref?.();
  } else {
    worker.proc.unref();
    stdoutHandle.unref?.();
  }
}

function runWin32Command(command: string): Promise<string[]> {
  pendingCommands += 1;
  const result = workerQueue.then(async () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    const worker = ensureWin32Worker();
    setWorkerRef(worker, true);
    try {
      worker.proc.stdin.write(`${command}\n`);
      const response = await worker.nextLine();
      const parts = response.split('\t');
      if (parts[0] !== 'ok') {
        throw new Error(parts.slice(1).join('\t') || 'win32 sparse operation failed');
      }
      return parts.slice(1);
    } finally {
      pendingCommands = Math.max(0, pendingCommands - 1);
      if (pendingCommands === 0) {
        if (activeWorker === worker) setWorkerRef(worker, false);
        armIdleClose();
      }
    }
  });
  workerQueue = result.then(() => undefined, () => undefined);
  return result;
}

function encodePath(filePath: string): string {
  return Buffer.from(filePath, 'utf8').toString('base64');
}

export async function allocatedFileBytes(filePath: string): Promise<number | undefined> {
  if (process.platform === 'win32') {
    try {
      const [raw] = await runWin32Command(`size\t${encodePath(filePath)}`);
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    } catch {
      const info = await stat(filePath).catch(() => undefined);
      return info?.size;
    }
  }
  try {
    const info = await stat(filePath);
    return typeof info.blocks === 'number' && info.blocks >= 0 ? info.blocks * 512 : info.size;
  } catch {
    return undefined;
  }
}

export async function punchSparseRanges(filePath: string, ranges: readonly SparseRange[]): Promise<SparsePunchResult> {
  const normalized = mergeSparseRanges(
    ranges.map((range) => ({
      start: Math.ceil(range.start / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES,
      end: Math.floor(range.end / SPARSE_UNIT_BYTES) * SPARSE_UNIT_BYTES,
    })),
  );
  if (normalized.length === 0) {
    const allocated = await allocatedFileBytes(filePath);
    return {
      supported: process.platform === 'win32',
      punchedRanges: [],
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
    };
  }
  if (process.platform !== 'win32') {
    const allocated = await allocatedFileBytes(filePath);
    return {
      supported: false,
      punchedRanges: [],
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
    };
  }
  const spec = normalized.map((range) => `${range.start}:${range.end}`).join(',');
  try {
    const [beforeRaw, afterRaw] = await runWin32Command(`punch\t${encodePath(filePath)}\t${spec}`);
    const before = Number(beforeRaw);
    const after = Number(afterRaw);
    return {
      supported: true,
      punchedRanges: normalized,
      allocatedBytesBefore: Number.isSafeInteger(before) ? before : undefined,
      allocatedBytesAfter: Number.isSafeInteger(after) ? after : undefined,
    };
  } catch {
    const allocated = await allocatedFileBytes(filePath);
    return {
      supported: false,
      punchedRanges: [],
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
    };
  }
}

export async function captureFileBasicTimes(filePath: string): Promise<SavedFileTimes | undefined> {
  if (process.platform === 'win32') {
    try {
      const [creationTime, lastAccessTime, lastWriteTime, changeTime] = await runWin32Command(`gettimes\t${encodePath(filePath)}`);
      if (creationTime !== undefined && lastAccessTime !== undefined && lastWriteTime !== undefined && changeTime !== undefined) {
        return { kind: 'win32', creationTime, lastAccessTime, lastWriteTime, changeTime };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  try {
    const info = await stat(filePath);
    return { kind: 'posix', atime: info.atime, mtime: info.mtime };
  } catch {
    return undefined;
  }
}

export async function restoreFileBasicTimes(filePath: string, saved: SavedFileTimes | undefined): Promise<void> {
  if (saved === undefined) return;
  if (saved.kind === 'win32') {
    await runWin32Command(
      `settimes\t${encodePath(filePath)}\t${saved.creationTime}\t${saved.lastAccessTime}\t${saved.lastWriteTime}\t${saved.changeTime}`,
    ).catch(() => undefined);
    return;
  }
  await utimes(filePath, saved.atime, saved.mtime).catch(() => undefined);
}
