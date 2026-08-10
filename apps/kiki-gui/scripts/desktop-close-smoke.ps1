$ErrorActionPreference = 'Stop'

$guiRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exe = [IO.Path]::GetFullPath((Join-Path $guiRoot 'src-tauri\target\release\kiki.exe'))
$work = Split-Path -Parent $exe
$prior = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('kiki.exe', 'kiki-server.exe') })
if ($prior.Count -gt 0) {
    $prior | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath | Format-Table
    throw 'Existing Kiki process blocks isolated smoke.'
}

$tmpRoot = [IO.Path]::GetFullPath((Join-Path $guiRoot '.tmp'))
[IO.Directory]::CreateDirectory($tmpRoot) | Out-Null
$smokeHome = [IO.Path]::GetFullPath((Join-Path $tmpRoot ('close-smoke-' + [guid]::NewGuid().ToString('N'))))
if (-not $smokeHome.StartsWith($tmpRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe smoke path: $smokeHome"
}
[IO.Directory]::CreateDirectory($smokeHome) | Out-Null

$oldHome = $env:KIMI_CODE_HOME
$main = $null
$sidecarPid = $null
try {
    $env:KIMI_CODE_HOME = $smokeHome
    # This must start visible: the proof sends a real window-close message and
    # observes the transition from visible to hidden.
    $main = Start-Process -FilePath $exe -WorkingDirectory $work -PassThru
    $deadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 250
        $main.Refresh()
        $sidecar = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ParentProcessId -eq $main.Id -and $_.Name -eq 'kiki-server.exe' } |
            Select-Object -First 1
    } while ((-not $main.HasExited) -and ($main.MainWindowHandle -eq 0 -or $null -eq $sidecar) -and (Get-Date) -lt $deadline)

    if ($main.HasExited) { throw "Kiki exited before smoke (code $($main.ExitCode))." }
    if ($main.MainWindowHandle -eq 0) { throw 'Kiki main window did not appear.' }
    if ($null -eq $sidecar) { throw 'Owned Kiki sidecar did not appear.' }
    $sidecarPid = [int]$sidecar.ProcessId

    Add-Type -TypeDefinition @'
namespace KikiCloseSmoke {
  public static class NativeMethods {
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern System.IntPtr SendMessage(System.IntPtr hWnd, uint msg, System.IntPtr wParam, System.IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(System.IntPtr hWnd);
  }
}
'@

    $hwnd = [IntPtr]$main.MainWindowHandle
    if (-not [KikiCloseSmoke.NativeMethods]::IsWindowVisible($hwnd)) {
        throw 'Kiki window was not visible before default close.'
    }
    [void][KikiCloseSmoke.NativeMethods]::SendMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Seconds 2
    $main.Refresh()
    $sidecarAlive = $null -ne (Get-Process -Id $sidecarPid -ErrorAction SilentlyContinue)
    $visibleAfter = [KikiCloseSmoke.NativeMethods]::IsWindowVisible($hwnd)
    if ($main.HasExited -or -not $sidecarAlive -or $visibleAfter) {
        throw "Default close failed: mainExited=$($main.HasExited) sidecarAlive=$sidecarAlive visibleAfter=$visibleAfter"
    }
    Write-Output "[smoke] default close hid window; mainPid=$($main.Id) sidecarPid=$sidecarPid bothAlive=true"

    $prefsDir = Join-Path $smokeHome 'kiki'
    [IO.Directory]::CreateDirectory($prefsDir) | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $prefsDir 'desktop.json'),
        '{"notifications":true,"closeToTray":false}',
        [Text.UTF8Encoding]::new($false)
    )

    # The single-instance callback reveals the existing hidden window. The
    # next close then re-reads the isolated explicit false preference.
    $second = Start-Process -FilePath $exe -WorkingDirectory $work -PassThru
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
    } while ((-not [KikiCloseSmoke.NativeMethods]::IsWindowVisible($hwnd)) -and (Get-Date) -lt $deadline)
    if (-not [KikiCloseSmoke.NativeMethods]::IsWindowVisible($hwnd)) {
        throw 'Second launch did not reveal the hidden single-instance window.'
    }

    [void][KikiCloseSmoke.NativeMethods]::SendMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    if (-not $main.WaitForExit(15000)) { throw 'Explicit quit close did not exit Kiki.' }
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $sidecarAlive = $null -ne (Get-Process -Id $sidecarPid -ErrorAction SilentlyContinue)
    } while ($sidecarAlive -and (Get-Date) -lt $deadline)
    if ($sidecarAlive) { throw 'Explicit quit close did not stop the owned sidecar.' }
    Write-Output "[smoke] explicit quit exited main and owned sidecar; mainExitCode=$($main.ExitCode)"
} finally {
    if ($null -ne $main -and -not $main.HasExited) {
        Stop-Process -Id $main.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $sidecarPid) {
        Stop-Process -Id $sidecarPid -Force -ErrorAction SilentlyContinue
    }
    $env:KIMI_CODE_HOME = $oldHome
    Start-Sleep -Milliseconds 300
    $resolvedSmoke = [IO.Path]::GetFullPath($smokeHome)
    if ($resolvedSmoke.StartsWith($tmpRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedSmoke)) {
        Remove-Item -LiteralPath $resolvedSmoke -Recurse -Force
    }
}
