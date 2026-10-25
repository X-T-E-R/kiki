[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $Executable,
  [Parameter(Mandatory = $true)]
  [string] $ResourceFile,
  [int] $ResourceType = 16,
  [int] $ResourceName = 1,
  [int] $Language = 1033
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class KikiVersionResourceNative
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr BeginUpdateResource(string fileName, bool deleteExistingResources);

    [DllImport("kernel32.dll", EntryPoint = "UpdateResourceW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UpdateResource(
        IntPtr updateHandle,
        IntPtr resourceType,
        IntPtr resourceName,
        ushort language,
        [In] byte[] resourceData,
        uint resourceDataLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EndUpdateResource(IntPtr updateHandle, bool discard);
}
'@

if (-not [IO.File]::Exists($Executable)) {
  throw "Executable does not exist: $Executable"
}
if (-not [IO.File]::Exists($ResourceFile)) {
  throw "Version resource does not exist: $ResourceFile"
}

$updateHandle = [KikiVersionResourceNative]::BeginUpdateResource($Executable, $false)
if ($updateHandle -eq [IntPtr]::Zero) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "BeginUpdateResource failed for $Executable (Win32 error $errorCode)"
}

$committed = $false
try {
  $resourceData = [IO.File]::ReadAllBytes($ResourceFile)
  $updated = [KikiVersionResourceNative]::UpdateResource(
    $updateHandle,
    [IntPtr]$ResourceType,
    [IntPtr]$ResourceName,
    [uint16]$Language,
    $resourceData,
    [uint32]$resourceData.Length)
  if (-not $updated) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "UpdateResource failed for $Executable (Win32 error $errorCode)"
  }
  $committed = $true
}
finally {
  $ended = [KikiVersionResourceNative]::EndUpdateResource($updateHandle, -not $committed)
  if (-not $ended -and $committed) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "EndUpdateResource failed for $Executable (Win32 error $errorCode)"
  }
}
