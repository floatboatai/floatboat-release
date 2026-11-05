# ABOUTME: 在隔离目录验证外部硬链接持锁能否同时阻止映像启动并允许整目录切换。
param([Parameter(Mandatory = $true)][string] $OutputDirectory)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw 'Run this probe in Windows PowerShell 5.1.'
}
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'OutputDirectory must be absolute.' }
$probeRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $probeRoot) { throw 'Use a new output directory.' }
$null = New-Item -ItemType Directory -Path $probeRoot
$probeExecutable = Join-Path $probeRoot 'ProbeProcess.exe'
$native = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class HardLinkProbeNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes, CreatedLow, CreatedHigh, AccessedLow, AccessedHigh, WrittenLow, WrittenHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateHardLinkW(string link, string existing, IntPtr security);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(IntPtr handle, out FileInformation information);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static void CreateLink(string link, string existing)
    {
        if (!CreateHardLinkW(link, existing, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static string Identity(string path)
    {
        IntPtr handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            FileInformation information;
            if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return information.Volume.ToString("X8") + ":" + information.IndexHigh.ToString("X8") + information.IndexLow.ToString("X8");
        }
        finally { CloseHandle(handle); }
    }
    public static IntPtr Lock(string path, bool deleteOnClose)
    {
        uint access = deleteOnClose ? 0x80010000U : 0x80000000U;
        uint flags = deleteOnClose ? 0x04000080U : 0x80U;
        IntPtr handle = CreateFileW(path, access, 4, IntPtr.Zero, 3, flags, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    public static void Unlock(IntPtr handle)
    {
        if (!CloseHandle(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static int Main(string[] arguments) { return 0; }
}
'@
Add-Type -TypeDefinition $native -Language CSharp -OutputAssembly $probeExecutable -OutputType ConsoleApplication -ReferencedAssemblies @('System.dll')
$null = [Reflection.Assembly]::LoadFile($probeExecutable)
$allResults = New-Object 'System.Collections.Generic.List[object]'
$cleanupFailures = New-Object 'System.Collections.Generic.List[string]'
$observations = $null
$caseRoot = $null

function Get-InnermostProbeException($Exception) {
  while ($null -ne $Exception.InnerException) { $Exception = $Exception.InnerException }
  return $Exception
}

function Start-ProbeProcess([string] $Path) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $Path
  $start.WorkingDirectory = $caseRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $process = [Diagnostics.Process]::Start($start)
  $null = $process.Handle
  return $process
}

function Assert-ProbeLaunchAllowed([string] $Path, [string] $Phase) {
  $process = Start-ProbeProcess $Path
  try {
    if (-not $process.WaitForExit(15000)) {
      $process.Kill()
      $null = $process.WaitForExit(5000)
      throw 'The controlled probe process did not exit.'
    }
    if ($process.ExitCode -ne 0) { throw "Probe executable exited with $($process.ExitCode)." }
    $observations.Add([pscustomobject]@{ operation = 'launch-allowed'; phase = $Phase; path = $Path; exit = $process.ExitCode })
  } finally { $process.Dispose() }
}

function Assert-ProbeLaunchBlocked([string] $Path, [string] $Phase) {
  $failure = $null
  $process = $null
  try { $process = Start-ProbeProcess $Path } catch { $failure = Get-InnermostProbeException $_.Exception }
  if ($null -ne $process) {
    try { if (-not $process.WaitForExit(5000)) { $process.Kill(); $null = $process.WaitForExit(5000) } }
    finally { $process.Dispose() }
    throw "CreateProcess unexpectedly succeeded for $Path"
  }
  if ($failure -isnot [ComponentModel.Win32Exception] -or $failure.NativeErrorCode -notin @(5, 32, 33)) { throw $failure }
  $observations.Add([pscustomobject]@{ operation = 'launch-blocked'; phase = $Phase; path = $Path; nativeError = $failure.NativeErrorCode })
}

function Assert-ProbeRead([string] $Path, [bool] $Allowed, [string] $Phase, [string] $ExpectedHash) {
  $stream = $null
  $failure = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') } finally { $sha.Dispose() }
    if ($hash -ne $ExpectedHash) { throw 'Probe content changed.' }
  } catch { $failure = Get-InnermostProbeException $_.Exception }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
  if ($Allowed) {
    if ($null -ne $failure) { throw $failure }
    $observations.Add([pscustomobject]@{ operation = 'read-allowed'; phase = $Phase; path = $Path; sha256 = $hash })
  } else {
    if ($null -eq $failure) { throw "File content unexpectedly remained readable for $Path" }
    $nativeError = $failure.HResult -band 0xFFFF
    if (($failure -isnot [IO.IOException] -and $failure -isnot [UnauthorizedAccessException]) -or $nativeError -notin @(5, 32, 33)) { throw $failure }
    $observations.Add([pscustomobject]@{ operation = 'read-blocked'; phase = $Phase; path = $Path; nativeError = $nativeError })
  }
}

$expectedHash = (Get-FileHash -LiteralPath $probeExecutable -Algorithm SHA256).Hash
foreach ($mode in @('external-link', 'external-link-delete-on-close')) {
  $caseRoot = Join-Path $probeRoot $mode
  $installation = Join-Path $caseRoot "Floatboat O'Brien 旧版"
  $candidate = Join-Path $caseRoot 'candidate 新版'
  $backup = Join-Path $caseRoot 'backup'
  $aliasRoot = Join-Path $caseRoot 'outside-locks'
  foreach ($directory in @($aliasRoot, (Join-Path $installation 'runtime'), (Join-Path $candidate 'runtime'))) {
    $null = New-Item -ItemType Directory -Path $directory -Force
  }
  $oldPaths = @((Join-Path $installation 'Floatboat.exe'), (Join-Path $installation 'runtime\node.exe'))
  $newPaths = @((Join-Path $candidate 'Floatboat.exe'), (Join-Path $candidate 'runtime\node.exe'))
  $allPaths = $oldPaths + $newPaths
  $handles = New-Object 'System.Collections.Generic.List[IntPtr]'
  $aliases = New-Object 'System.Collections.Generic.List[string]'
  $observations = New-Object 'System.Collections.Generic.List[object]'
  $result = [ordered]@{ mode = $mode; status = 'failed'; error = $null; nativeError = $null; observations = @() }
  try {
    $index = 0
    foreach ($path in $allPaths) {
      Copy-Item -LiteralPath $probeExecutable -Destination $path
      Assert-ProbeLaunchAllowed $path 'before-lock'
      Assert-ProbeRead $path $true 'before-lock' $expectedHash
      $alias = Join-Path $aliasRoot ("lock-$index.exe")
      $index++
      [HardLinkProbeNative]::CreateLink($alias, $path)
      $aliases.Add($alias)
      $originalIdentity = [HardLinkProbeNative]::Identity($path)
      $aliasIdentity = [HardLinkProbeNative]::Identity($alias)
      if ($originalIdentity -ne $aliasIdentity) { throw 'External link did not identify the original file.' }
      $observations.Add([pscustomobject]@{ operation = 'hardlink-identity'; path = $path; alias = $alias; identity = $originalIdentity })
      $handles.Add([HardLinkProbeNative]::Lock($alias, ($mode -eq 'external-link-delete-on-close')))
    }
    foreach ($path in $allPaths) {
      Assert-ProbeLaunchBlocked $path 'before-rename'
      Assert-ProbeRead $path $false 'before-rename' $expectedHash
    }
    [IO.Directory]::Move($installation, $backup)
    $observations.Add([pscustomobject]@{ operation = 'rename-old-to-backup'; success = $true })
    [IO.Directory]::Move($candidate, $installation)
    $observations.Add([pscustomobject]@{ operation = 'rename-candidate-to-installation'; success = $true })
    $switchedPaths = @((Join-Path $backup 'Floatboat.exe'), (Join-Path $backup 'runtime\node.exe'), (Join-Path $installation 'Floatboat.exe'), (Join-Path $installation 'runtime\node.exe'))
    foreach ($path in $switchedPaths) {
      Assert-ProbeLaunchBlocked $path 'after-rename'
      Assert-ProbeRead $path $false 'after-rename' $expectedHash
    }
    foreach ($handle in $handles) { [HardLinkProbeNative]::Unlock($handle) }
    $handles.Clear()
    foreach ($path in $switchedPaths) {
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Releasing the alias unexpectedly removed an original executable.' }
      Assert-ProbeLaunchAllowed $path 'after-release'
      Assert-ProbeRead $path $true 'after-release' $expectedHash
    }
    foreach ($alias in $aliases) {
      $exists = Test-Path -LiteralPath $alias
      if ($exists -eq ($mode -eq 'external-link-delete-on-close')) { throw 'The alias deletion behavior did not match the requested mode.' }
      $observations.Add([pscustomobject]@{ operation = 'alias-after-release'; path = $alias; exists = $exists })
    }
    $result.status = 'passed'
  } catch {
    $failure = Get-InnermostProbeException $_.Exception
    $result.error = $failure.Message
    if ($failure -is [ComponentModel.Win32Exception]) { $result.nativeError = $failure.NativeErrorCode }
    else { $result.nativeError = $failure.HResult -band 0xFFFF }
  } finally {
    foreach ($handle in $handles) {
      try { [HardLinkProbeNative]::Unlock($handle) } catch { $cleanupFailures.Add($_.Exception.Message) }
    }
    foreach ($alias in $aliases) {
      try { if (Test-Path -LiteralPath $alias) { [IO.File]::Delete($alias) } } catch { $cleanupFailures.Add($_.Exception.Message) }
    }
    $result.observations = @($observations.ToArray())
  }
  $allResults.Add([pscustomobject]$result)
}
$report = [ordered]@{
  powershell = $PSVersionTable.PSVersion.ToString()
  os = [Environment]::OSVersion.VersionString
  filesystem = (New-Object IO.DriveInfo([IO.Path]::GetPathRoot($probeRoot))).DriveFormat
  executableSha256 = $expectedHash
  cases = @($allResults.ToArray())
  cleanupFailures = @($cleanupFailures.ToArray())
}
$reportPath = Join-Path $probeRoot 'report.json'
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$allResults | ForEach-Object { Write-Output "$($_.mode): $($_.status) $($_.error)" }
Write-Output "Evidence: $reportPath"
if (@($allResults | Where-Object { $_.status -ne 'passed' }).Count -gt 0 -or $cleanupFailures.Count -gt 0) {
  throw 'External hardlink guard probe failed; inspect report.json.'
}
