using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class WindowsProcessHelper
{
    [StructLayout(LayoutKind.Sequential)]
    struct Startup
    {
        public int size;
        public IntPtr reserved, desktop, title;
        public int x, y, width, height, columns, rows, fill, flags;
        public short show, reservedSize;
        public IntPtr reservedData, input, output, error;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo
    {
        public IntPtr process, thread;
        public uint pid, tid;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minimum, maximum;
        public uint active;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits limits;
        public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long user, kernel, totalUser, totalKernel;
        public uint faults, total, active, terminated;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FileZeroDataInformation
    {
        public long FileOffset;
        public long BeyondFinalZero;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FileBasicInfo
    {
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public long ChangeTime;
        public uint FileAttributes;
    }

    const uint FSCTL_SET_SPARSE = 0x000900C4;
    const uint FSCTL_SET_ZERO_DATA = 0x000980C8;
    const uint GENERIC_READ = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_READ_ATTRIBUTES = 0x0080;
    const uint FILE_WRITE_ATTRIBUTES = 0x0100;
    const uint OPEN_EXISTING = 3;
    const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
    const uint FILE_ATTRIBUTE_SPARSE_FILE = 0x00000200;
    const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
    const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint STILL_ACTIVE = 259;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, int size, IntPtr returnedSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string application, string command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr process, uint code);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(string lpFileName, uint dwDesiredAccess, FileShare dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle hDevice, uint dwIoControlCode, IntPtr lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle hDevice, uint dwIoControlCode, ref FileZeroDataInformation lpInBuffer, uint nInBufferSize, IntPtr lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetFileAttributesW(string lpFileName);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool MoveFileExW(string lpExistingFileName, string lpNewFileName, uint dwFlags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle hFile, int FileInformationClass, out FileBasicInfo lpFileInformation, uint dwBufferSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle hFile, int FileInformationClass, ref FileBasicInfo lpFileInformation, uint dwBufferSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FlushFileBuffers(SafeFileHandle hFile);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr hProcess, out long lpCreationTime, out long lpExitTime, out long lpKernelTime, out long lpUserTime);

    static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    static void Send(StreamWriter writer, string message)
    {
        lock (writer) writer.WriteLine(message);
    }

    static void Failure(StreamWriter writer, string phase, Exception error)
    {
        var native = error as Win32Exception;
        Send(writer, "error:" + phase + ":" + (native == null ? 0 : native.NativeErrorCode) + ":" + Convert.ToBase64String(Encoding.UTF8.GetBytes(error.Message)));
    }

    static string LongPath(string path)
    {
        string normalized = path.Replace('/', '\\');
        if (normalized.StartsWith(@"\\?\")) return normalized;
        if (normalized.StartsWith(@"\\")) return @"\\?\UNC\" + normalized.Substring(2);
        return @"\\?\" + normalized;
    }

    static long AllocatedBytes(string path)
    {
        string lp = LongPath(path);
        uint high;
        uint low = GetCompressedFileSizeW(lp, out high);
        int err = Marshal.GetLastWin32Error();
        if (low == 0xFFFFFFFFu && err != 0) throw new Win32Exception(err, "GetCompressedFileSizeW");
        return ((long)high << 32) | (long)low;
    }

    static int IsSparse(string path)
    {
        string lp = LongPath(path);
        uint attrs = GetFileAttributesW(lp);
        if (attrs == INVALID_FILE_ATTRIBUTES)
        {
            int err = Marshal.GetLastWin32Error();
            if (err == 2 || err == 3) return 0;
            throw new Win32Exception(err, "GetFileAttributesW");
        }
        return (attrs & FILE_ATTRIBUTE_SPARSE_FILE) != 0 ? 1 : 0;
    }

    static void ReplaceAtomic(string srcPath, string dstPath)
    {
        string src = LongPath(srcPath);
        string dst = LongPath(dstPath);
        int lastErr = 0;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            if (MoveFileExW(src, dst, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return;
            lastErr = Marshal.GetLastWin32Error();
            if (lastErr != 5 && lastErr != 32) break;
            Thread.Sleep(10 * (attempt + 1));
        }
        throw new Win32Exception(lastErr, "MoveFileExW");
    }

    static string GetTimes(string path)
    {
        string lp = LongPath(path);
        using (SafeFileHandle handle = CreateFileW(lp, FILE_READ_ATTRIBUTES, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW");
            FileBasicInfo basic;
            if (!GetFileInformationByHandleEx(handle, 0, out basic, (uint)Marshal.SizeOf(typeof(FileBasicInfo))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandleEx");
            return basic.CreationTime + "\t" + basic.LastAccessTime + "\t" + basic.LastWriteTime + "\t" + basic.ChangeTime;
        }
    }

    static void SetTimes(string path, long c, long a, long w, long ch)
    {
        string lp = LongPath(path);
        using (SafeFileHandle handle = CreateFileW(lp, GENERIC_WRITE | FILE_WRITE_ATTRIBUTES, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW");
            if (!FlushFileBuffers(handle))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "FlushFileBuffers");
            FileBasicInfo basic;
            if (!GetFileInformationByHandleEx(handle, 0, out basic, (uint)Marshal.SizeOf(typeof(FileBasicInfo))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandleEx");
            basic.CreationTime = c;
            basic.LastAccessTime = a;
            basic.LastWriteTime = w;
            basic.ChangeTime = ch;
            basic.FileAttributes = 0;
            if (!SetFileInformationByHandle(handle, 0, ref basic, (uint)Marshal.SizeOf(typeof(FileBasicInfo))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetFileInformationByHandle");
        }
    }

    static string PunchRanges(string path, string rangeSpec)
    {
        string lp = LongPath(path);
        long before;
        try
        {
            before = AllocatedBytes(path);
        }
        catch (Exception ex)
        {
            return "pre_err\tallocated_before:" + ex.Message.Replace("\r", " ").Replace("\n", " ");
        }

        SafeFileHandle handle = CreateFileW(lp, GENERIC_READ | GENERIC_WRITE | FILE_WRITE_ATTRIBUTES, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int openErr = Marshal.GetLastWin32Error();
            return "pre_err\topen:" + openErr + ":" + new Win32Exception(openErr).Message.Replace("\r", " ").Replace("\n", " ");
        }

        FileBasicInfo savedBasic;
        bool hasSavedBasic = false;
        string mutErr = null;
        try
        {
            if (!GetFileInformationByHandleEx(handle, 0, out savedBasic, (uint)Marshal.SizeOf(typeof(FileBasicInfo))))
            {
                int infoErr = Marshal.GetLastWin32Error();
                return "pre_err\tget_basic_info:" + infoErr + ":" + new Win32Exception(infoErr).Message.Replace("\r", " ").Replace("\n", " ");
            }
            hasSavedBasic = true;
            savedBasic.FileAttributes = 0;

            uint bytesReturned;
            if (!DeviceIoControl(handle, FSCTL_SET_SPARSE, IntPtr.Zero, 0, IntPtr.Zero, 0, out bytesReturned, IntPtr.Zero))
            {
                int sparseErr = Marshal.GetLastWin32Error();
                return "pre_err\tset_sparse:" + sparseErr + ":" + new Win32Exception(sparseErr).Message.Replace("\r", " ").Replace("\n", " ");
            }

            try
            {
                if (!string.IsNullOrEmpty(rangeSpec))
                {
                    string[] items = rangeSpec.Split(',');
                    uint infoSize = (uint)Marshal.SizeOf(typeof(FileZeroDataInformation));
                    foreach (string item in items)
                    {
                        if (string.IsNullOrEmpty(item)) continue;
                        string[] bounds = item.Split(':');
                        FileZeroDataInformation zeroInfo = new FileZeroDataInformation();
                        zeroInfo.FileOffset = long.Parse(bounds[0]);
                        zeroInfo.BeyondFinalZero = long.Parse(bounds[1]);
                        if (!DeviceIoControl(handle, FSCTL_SET_ZERO_DATA, ref zeroInfo, infoSize, IntPtr.Zero, 0, out bytesReturned, IntPtr.Zero))
                        {
                            int zeroErr = Marshal.GetLastWin32Error();
                            mutErr = "zero_data:" + zeroErr + ":" + new Win32Exception(zeroErr).Message;
                            break;
                        }
                    }
                }
            }
            catch (Exception loopEx)
            {
                mutErr = "zero_loop:" + loopEx.Message;
            }
            finally
            {
                if (!FlushFileBuffers(handle))
                {
                    int flushErr = Marshal.GetLastWin32Error();
                    if (mutErr == null) mutErr = "flush:" + flushErr + ":" + new Win32Exception(flushErr).Message;
                }
                if (hasSavedBasic && !SetFileInformationByHandle(handle, 0, ref savedBasic, (uint)Marshal.SizeOf(typeof(FileBasicInfo))))
                {
                    int timeErr = Marshal.GetLastWin32Error();
                    if (mutErr == null) mutErr = "restore_times:" + timeErr + ":" + new Win32Exception(timeErr).Message;
                }
            }
        }
        finally
        {
            handle.Dispose();
        }

        if (mutErr != null)
            return "mut_err\t" + mutErr.Replace("\r", " ").Replace("\n", " ");

        try
        {
            long after = AllocatedBytes(path);
            return "ok\t" + before + "\t" + after;
        }
        catch (Exception afterEx)
        {
            return "mut_err\tallocated_after:" + afterEx.Message.Replace("\r", " ").Replace("\n", " ");
        }
    }

    static string ProcessCreationFileTime(uint pid)
    {
        IntPtr hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hProc == IntPtr.Zero)
        {
            int err = Marshal.GetLastWin32Error();
            if (err == 87) return "dead";
            if (err == 5) return "denied";
            throw new Win32Exception(err, "OpenProcess");
        }
        try
        {
            uint exitCode;
            if (GetExitCodeProcess(hProc, out exitCode) && exitCode != STILL_ACTIVE)
                return "dead";
            long creation, exit, kernel, user;
            Check(GetProcessTimes(hProc, out creation, out exit, out kernel, out user), "GetProcessTimes");
            return creation.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        finally
        {
            CloseHandle(hProc);
        }
    }

    static int RunSparseWorker()
    {
        var utf8NoBom = new UTF8Encoding(false);
        using (var reader = new StreamReader(Console.OpenStandardInput(), utf8NoBom))
        using (var writer = new StreamWriter(Console.OpenStandardOutput(), utf8NoBom))
        {
            writer.AutoFlush = true;
            writer.WriteLine("ready\tsparse-v1");
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                try
                {
                    string[] parts = line.Split('\t');
                    string cmd = parts[0];
                    if (cmd == "ping")
                    {
                        writer.WriteLine("ok\t1");
                        continue;
                    }
                    if (cmd == "proctime")
                    {
                        writer.WriteLine("ok\t" + ProcessCreationFileTime(uint.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture)));
                        continue;
                    }
                    string path = Encoding.UTF8.GetString(Convert.FromBase64String(parts[1]));
                    if (cmd == "size")
                    {
                        writer.WriteLine("ok\t" + AllocatedBytes(path));
                    }
                    else if (cmd == "attrs")
                    {
                        writer.WriteLine("ok\t" + IsSparse(path));
                    }
                    else if (cmd == "replace")
                    {
                        string dst = Encoding.UTF8.GetString(Convert.FromBase64String(parts[2]));
                        ReplaceAtomic(path, dst);
                        writer.WriteLine("ok\t0");
                    }
                    else if (cmd == "gettimes")
                    {
                        writer.WriteLine("ok\t" + GetTimes(path));
                    }
                    else if (cmd == "settimes")
                    {
                        SetTimes(path, long.Parse(parts[2]), long.Parse(parts[3]), long.Parse(parts[4]), long.Parse(parts[5]));
                        writer.WriteLine("ok\t0");
                    }
                    else if (cmd == "punch")
                    {
                        writer.WriteLine(PunchRanges(path, parts[2]));
                    }
                    else
                    {
                        writer.WriteLine("err\tunknown command");
                    }
                }
                catch (Exception ex)
                {
                    writer.WriteLine("err\t" + ex.Message.Replace("\r", " ").Replace("\n", " "));
                }
            }
        }
        return 0;
    }

    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--sparse-worker" && args[1] == "v1") return RunSparseWorker();
        if (args.Length != 1) return 2;
        const int UnreleasedExit = 6;
        bool releaseCompleted = false;
        IntPtr job = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        Thread waiter = null;
        var retained = new ManualResetEvent(false);
        var stopWatching = new ManualResetEvent(false);
        try
        {
            var security = new PipeSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            using (var input = new NamedPipeServerStream(args[0] + "-in", PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security, HandleInheritability.Inheritable))
            using (var output = new NamedPipeServerStream(args[0] + "-out", PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security, HandleInheritability.Inheritable))
            using (var errorPipe = new NamedPipeServerStream(args[0] + "-err", PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security, HandleInheritability.Inheritable))
            using (var pipe = new NamedPipeServerStream(args[0], PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security))
            {
                var connection = pipe.BeginWaitForConnection(null, null);
                if (!connection.AsyncWaitHandle.WaitOne(10000)) return 3;
                pipe.EndWaitForConnection(connection);
                connection.AsyncWaitHandle.Close();
                input.WaitForConnection();
                output.WaitForConnection();
                errorPipe.WaitForConnection();
                using (var reader = new StreamReader(pipe, Encoding.UTF8))
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false)))
                {
                    writer.AutoFlush = true;
                    try
                    {
                        var launch = (reader.ReadLine() ?? "").Split(':');
                        bool ownerLifetime = launch.Length == 5 && launch[4] == "owner-v1";
                        if (launch.Length != 4 && !ownerLifetime) throw new FormatException("Invalid process launch request.");
                        job = CreateJobObject(IntPtr.Zero, null);
                        Check(job != IntPtr.Zero, "CreateJobObject");
                        var limits = new ExtendedLimits();
                        limits.limits.flags = 0x2000;
                        Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)), "SetInformationJobObject");
                        var startup = new Startup();
                        startup.size = Marshal.SizeOf(startup);
                        startup.flags = 0x100;
                        startup.input = input.SafePipeHandle.DangerousGetHandle();
                        startup.output = output.SafePipeHandle.DangerousGetHandle();
                        startup.error = launch[3] == "merge" ? startup.output : errorPipe.SafePipeHandle.DangerousGetHandle();
                        Check(CreateProcess(Encoding.UTF8.GetString(Convert.FromBase64String(launch[0])), Encoding.UTF8.GetString(Convert.FromBase64String(launch[1])), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, Encoding.UTF8.GetString(Convert.FromBase64String(launch[2])), ref startup, out child), "CreateProcess");
                        Check(AssignProcessToJobObject(job, child.process), "AssignProcessToJobObject");
                        input.Dispose();
                        output.Dispose();
                        errorPipe.Dispose();
                        Check(ResumeThread(child.thread) != 0xffffffff, "ResumeThread");
                        Send(writer, "ready:" + child.pid + (ownerLifetime ? ":owner-v1" : "") + ":release-exit-v2");
                        waiter = new Thread(() =>
                        {
                            WaitForSingleObject(child.process, 0xffffffff);
                            uint code;
                            try
                            {
                                Check(GetExitCodeProcess(child.process, out code), "GetExitCodeProcess");
                                Send(writer, "exit:" + code);
                                if (ownerLifetime && WaitHandle.WaitAny(new WaitHandle[] { retained, stopWatching }) == 0)
                                {
                                    while (!stopWatching.WaitOne(250))
                                    {
                                        Accounting stats;
                                        if (!QueryInformationJobObject(job, 1, out stats, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                                        {
                                            Failure(writer, "watch", new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject"));
                                            break;
                                        }
                                        if (stats.active == 0) { Send(writer, "empty"); break; }
                                    }
                                }
                            }
                            catch (IOException) { }
                            catch (ObjectDisposedException) { }
                        });
                        waiter.IsBackground = true;
                        waiter.Start();
                        string request;
                        while ((request = reader.ReadLine()) != null)
                        {
                            if (request == "kill")
                            {
                                string phase = "terminate";
                                try
                                {
                                    Check(TerminateJobObject(job, 1), "TerminateJobObject");
                                    phase = "verify";
                                    var deadline = Stopwatch.StartNew();
                                    Accounting stats;
                                    do
                                    {
                                        Check(QueryInformationJobObject(job, 1, out stats, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
                                        if (stats.active == 0) break;
                                        Thread.Sleep(10);
                                    } while (deadline.ElapsedMilliseconds < 4000);
                                    Send(writer, "active:" + stats.active);
                                }
                                catch (Exception error) { Failure(writer, phase, error); }
                            }
                            else if (request == "retain" && ownerLifetime)
                            {
                                try
                                {
                                    Accounting stats;
                                    Check(QueryInformationJobObject(job, 1, out stats, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
                                    Send(writer, "active:" + stats.active);
                                    if (stats.active != 0) retained.Set();
                                }
                                catch (Exception error) { Failure(writer, "retain", error); }
                            }
                            else if (request == "release")
                            {
                                try
                                {
                                    limits.limits.flags = 0;
                                    Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)), "ReleaseJob");
                                    releaseCompleted = true;
                                    try { Send(writer, "released"); }
                                    catch (IOException) { }
                                    break;
                                }
                                catch (Exception error) { Failure(writer, "release", error); }
                            }
                        }
                    }
                    catch (Exception error) { Failure(writer, "launch", error); }
                }
            }
            return releaseCompleted ? 0 : UnreleasedExit;
        }
        catch (Exception error)
        {
            if (releaseCompleted && error is IOException) return 0;
            return 4;
        }
        finally
        {
            stopWatching.Set();
            if (child.process != IntPtr.Zero && waiter == null) TerminateProcess(child.process, 1);
            if (waiter != null && WaitForSingleObject(child.process, 0) == 0) waiter.Join(1000);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (waiter != null) waiter.Join(1000);
            retained.Dispose();
            stopWatching.Dispose();
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
            if (child.process != IntPtr.Zero) CloseHandle(child.process);
        }
    }
}
