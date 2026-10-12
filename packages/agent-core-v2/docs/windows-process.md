# Windows Bash process ownership

Windows Bash opts into `HostProcessOptions.ownedProcessTree`; ordinary host process spawns retain their existing path. `windowsProcessTree.ts` and `windowsProcessHelper.cs` own the opted-in process tree through one Windows Job Object, not a PID/parent-PID scan.

## Launch and cleanup

The precompiled helper starts the root suspended, assigns it to the Job, then resumes it. Launch arguments travel over a private named pipe rather than the helper command line. Separate pipes preserve stdin EOF and binary stdout/stderr. Pipe access is limited to the current Windows identity.

Cancellation and timeout terminate the Job even if its root already exited. Cleanup succeeds only after the helper confirms `active:0`. Normal completion instead removes kill-on-close and releases ownership, preserving resident descendants deliberately started by the command. A failed normal release keeps the control channel and Job available for a later stop attempt.

`ProcessTask` waits for cancellation cleanup and disposal before settlement. `os.process.kill_failed` carries `cleanupComplete:false`, `pid`, a `phase` (`terminate`, `verify`, `control`, `deadline`, or `release`), and optional `remainingProcessCount` or `win32Error`. The task consumer retains the diagnostic and does not claim a terminal cleanup result; stopping the same task can retry. A lost helper/control channel reports an unconfirmed failure. Kernel kill-on-close handles that abnormal loss; it does not promise to preserve residents in that case.

A missing helper or a launch failure produces `os.process.spawn_failed`. Rebuild or reinstall the matching artifact; do not fall back to taskkill for owned-tree cleanup or compile on the user's runtime machine.

## Build and packaging

`packages/agent-core-v2/scripts/build-windows-process-helper.mjs` is the only builder for the canonical C# source. Windows builds require the .NET Framework 4 compiler at `Microsoft.NET/Framework/v4.0.30319/csc.exe`. The runtime executable is AnyCPU MSIL using CLR 4, not self-contained; Windows Bash also needs Git for Windows. Public installation requirements live in the mirrored installation guide.

The core build places the helper in `core/dist`; source CLI development scripts prepare that asset before launching. SDK bundling copies it beside the SDK output. Non-SEA CLI builds place it in `dist/native`, and CLI bootstrap supplies that path. The node-local locator also handles source and SDK-relative layouts. SEA collection embeds the same helper under `runtime/process/windows-process-helper.exe`, with manifest hash verification and extraction through the existing native asset cache.

For npm publishing on Linux, the Windows x64 native lane stages its compiled helper at `windows-process-helper/win32-x64/windows-process-helper.exe`. The desktop release publisher sets `KIKI_WINDOWS_PROCESS_HELPER_ARTIFACT` to the downloaded artifact; the same builder copies its bytes into CLI `dist/native`. A specified missing or invalid artifact fails the build. Linux does not invoke a Windows compiler. POSIX native executables do not collect the Windows helper.

## Verification boundary

`test/os/backends/node-local/hostProcessService.test.ts` covers binary streams, long arguments, timeout, stop, root-first exit, unrelated processes, normal residents, and injected termination/release failures followed by retry through the real task consumer. CLI native asset tests cover extraction/repair, concurrent build consumers, missing compiler, precompiled cross-host staging, and both npm distributions.

The current candidate has Windows 11 x64 fixture evidence and ordinary CLI/SDK layout evidence. Windows 10, ARM64, missing-CLR machines and a complete installer remain separate release/runtime checks; successful local fixtures do not establish those outcomes.
