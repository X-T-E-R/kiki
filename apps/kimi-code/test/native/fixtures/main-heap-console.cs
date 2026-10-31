using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class MainHeapConsole {
  delegate bool Handler(uint kind);
  static Handler handler = kind => true;
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler routine, bool add);
  [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint kind, uint group);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);

  static int Main(string[] args) {
    ShowWindow(GetConsoleWindow(), 0);
    SetConsoleCtrlHandler(null, false);
    SetConsoleCtrlHandler(handler, true);
    var start = new ProcessStartInfo(args[0], "\"" + args[1] + "\" serve \"" + args[2] + "\"");
    start.UseShellExecute = false;
    start.EnvironmentVariables["NODE_OPTIONS"] = "";
    start.EnvironmentVariables["KIKI_HEAP_REEXEC"] = "";
    var child = Process.Start(start);
    File.WriteAllText(args[2] + ".controller", child.Id.ToString());
    var until = DateTime.UtcNow.AddSeconds(20);
    while (!File.Exists(args[2]) && DateTime.UtcNow < until) Thread.Sleep(25);
    if (!File.Exists(args[2])) { child.Kill(); return 92; }
    Thread.Sleep(150);
    if (args[3] == "close") {
      if (!PostMessage(GetConsoleWindow(), 0x0112, new IntPtr(0xF060), IntPtr.Zero)) { child.Kill(); return 93; }
    } else if (!GenerateConsoleCtrlEvent(args[3] == "break" ? 1U : 0U, 0)) { child.Kill(); return 93; }
    if (!child.WaitForExit(10000)) { child.Kill(); return 94; }
    File.WriteAllText(args[2] + ".exit", child.ExitCode.ToString());
    return child.ExitCode;
  }
}
