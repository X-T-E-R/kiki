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

    public static int Main(string[] args)
    {
        if (args.Length != 1) return 2;
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
                        Send(writer, "ready:" + child.pid + (ownerLifetime ? ":owner-v1" : ""));
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
                                    Send(writer, "released");
                                    break;
                                }
                                catch (Exception error) { Failure(writer, "release", error); }
                            }
                        }
                    }
                    catch (Exception error) { Failure(writer, "launch", error); }
                }
            }
            return 0;
        }
        catch { return 4; }
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
