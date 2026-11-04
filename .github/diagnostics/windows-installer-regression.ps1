#requires -Version 7.0
# ABOUTME: 在一次性 Windows runner 上刻画签名 RC4→RC5 覆盖安装、外部文件锁及长 TEMP 边界。
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('baseline', 'long-temp', 'external-lock', 'apostrophe-temp')][string]$Scenario,
  [Parameter(Mandatory)][string]$InstallerRC4,
  [Parameter(Mandatory)][string]$InstallerRC5,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][string]$ReportScript,
  [ValidateRange(60, 900)][int]$InstallerTimeoutSeconds = 600
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Owned = @{}
$script:Steps = [Collections.Generic.List[object]]::new()
$script:Checks = [Collections.Generic.List[object]]::new()
$script:ReportResults = @{}
$taskName = "fbqa-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
$InstallDirectory = 'C:\Program Files\Floatboat'
$ShortTemp = if ($Scenario -eq 'apostrophe-temp') { "C:\Floatboat's QA\$taskName-temp" } else { "C:\$taskName-temp" }
$LongTemp = Join-Path $ShortTemp ('segment-' + ('x' * 70))
$LongTemp = Join-Path $LongTemp ('segment-' + ('y' * 70))
$LongTemp = Join-Path $LongTemp ('segment-' + ('z' * 25))
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$script:Fatal = $null
$lockProcess = $null
$releaseLockFile = Join-Path $OutputDirectory 'release-lock'

function Write-Json([string]$Path, $Value) {
  $Value | ConvertTo-Json -Depth 18 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Add-Check([string]$Name, [bool]$Passed, $Details) {
  $script:Checks.Add([ordered]@{ name = $Name; passed = $Passed; details = $Details })
  Write-Host "$Name : $Passed"
}

function Get-InstallRegistrations {
  $roots = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
  foreach ($root in $roots) {
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if ($item -and $item.PSObject.Properties['DisplayName'] -and $item.DisplayName -like '*Floatboat*') {
        $record = [ordered]@{ key = $key.Name }
        foreach ($name in @('DisplayName','DisplayVersion','InstallLocation','UninstallString')) {
          $record[$name] = if ($item.PSObject.Properties[$name]) { $item.$name } else { $null }
        }
        $record
      }
    }
  }
}

function Read-AsarVersion([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
  try {
    $prefix = [byte[]]::new(16)
    if ($stream.Read($prefix, 0, 16) -ne 16) { throw 'ASAR header is truncated' }
    $headerSize = [BitConverter]::ToUInt32($prefix, 4)
    $jsonLength = [BitConverter]::ToUInt32($prefix, 12)
    if ($jsonLength -gt 64MB) { throw 'ASAR header exceeds diagnostic bound' }
    $bytes = [byte[]]::new($jsonLength)
    $stream.ReadExactly($bytes)
    $header = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -AsHashtable
    $entry = $header.files['package.json']
    if (-not $entry -or $entry.size -gt 1MB) { throw 'ASAR package.json missing or too large' }
    [void]$stream.Seek((8L + $headerSize + [long]$entry.offset), 'Begin')
    $packageBytes = [byte[]]::new([int]$entry.size)
    $stream.ReadExactly($packageBytes)
    ([Text.Encoding]::UTF8.GetString($packageBytes) | ConvertFrom-Json).version
  } finally { $stream.Dispose() }
}

function Get-InstalledState {
  $exe = Join-Path $InstallDirectory 'Floatboat.exe'
  $uninstaller = Join-Path $InstallDirectory 'Uninstall Floatboat.exe'
  $asar = Join-Path $InstallDirectory 'resources\app.asar'
  $state = [ordered]@{ directory = $InstallDirectory; exeExists = (Test-Path -LiteralPath $exe); uninstallerExists = (Test-Path -LiteralPath $uninstaller); asarExists = (Test-Path -LiteralPath $asar); productVersion = $null; fileVersion = $null; packageVersion = $null; versionReadError = $null; registrations = @(Get-InstallRegistrations) }
  try {
    if ($state.exeExists) {
      $version = (Get-Item -LiteralPath $exe).VersionInfo
      $state.productVersion = $version.ProductVersion
      $state.fileVersion = $version.FileVersion
    }
    $state.packageVersion = Read-AsarVersion $asar
  } catch { $state.versionReadError = $_.Exception.Message }
  $state
}

function Register-OwnedProcess([Diagnostics.Process]$Process, [string]$Reason, [string]$Operation = '') {
  try {
    $Process.EnableRaisingEvents = $true
    $script:Owned[[string]$Process.Id] = [ordered]@{ processId = $Process.Id; process = $Process; startTicks = $Process.StartTime.ToUniversalTime().Ticks; reason = $Reason; operation = $(if ($Operation) { $Operation } else { $Reason }); path = $Process.MainModule.FileName; exitCode = $null }
  } catch { Write-Warning "Cannot retain process identity: $($_.Exception.Message)" }
}

function Update-OwnedProcesses {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  for ($pass = 0; $pass -lt 4; $pass++) {
    foreach ($candidate in $all) {
      $key = [string]$candidate.ProcessId
      if ($script:Owned.ContainsKey($key)) { continue }
      $parent = $script:Owned[[string]$candidate.ParentProcessId]
      if (-not $parent) { continue }
      if ($candidate.CreationDate.ToUniversalTime().Ticks -lt $parent.startTicks) { continue }
      try {
        if ($parent.process.HasExited -and $candidate.CreationDate.ToUniversalTime() -gt $parent.process.ExitTime.ToUniversalTime()) { continue }
        Register-OwnedProcess (Get-Process -Id $candidate.ProcessId -ErrorAction Stop) "descendant of $($parent.processId)" $parent.operation
      } catch { }
    }
  }
  foreach ($identity in $script:Owned.Values) {
    try { if ($identity.process.HasExited) { $identity.exitCode = $identity.process.ExitCode } } catch { }
  }
}

function Stop-OwnedProcesses {
  Update-OwnedProcesses
  foreach ($identity in @($script:Owned.Values | Sort-Object startTicks -Descending)) {
    try {
      $current = Get-Process -Id $identity.processId -ErrorAction Stop
      if ($current.StartTime.ToUniversalTime().Ticks -eq $identity.startTicks) { $current.Kill(); [void]$current.WaitForExit(5000) }
    } catch { }
  }
  Update-OwnedProcesses
}

function Save-Diagnostics([string]$Label) {
  Update-OwnedProcesses
  $dir = Join-Path $OutputDirectory $Label
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $owned = @($all | Where-Object { $script:Owned.ContainsKey([string]$_.ProcessId) } | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate)
  Write-Json (Join-Path $dir 'processes.json') $owned
  Write-Json (Join-Path $dir 'installed-state.json') (Get-InstalledState)
  $items = @(Get-ChildItem -LiteralPath $InstallDirectory -Recurse -File -ErrorAction SilentlyContinue)
  Write-Json (Join-Path $dir 'longest-installed-paths.json') @($items | Sort-Object { $_.FullName.Length } -Descending | Select-Object -First 100 @{n='path';e={$_.FullName}},Length,@{n='pathLength';e={$_.FullName.Length}})
  $windows = foreach ($identity in $script:Owned.Values) {
    try { $p = Get-Process -Id $identity.processId -ErrorAction Stop; if ($p.StartTime.ToUniversalTime().Ticks -eq $identity.startTicks) { [ordered]@{ processId = $p.Id; title = $p.MainWindowTitle; responding = $p.Responding; windowText = @([InstallerDiagnosticWindows]::ReadText($p.Id)) } } } catch { }
  }
  Write-Json (Join-Path $dir 'windows.json') @($windows)
  if (Test-Path -LiteralPath $InstallDirectory) {
    try { (Get-Acl -LiteralPath $InstallDirectory).Sddl | Set-Content -LiteralPath (Join-Path $dir 'install-acl.txt') } catch { }
  }
  if (Test-Path -LiteralPath $ReportScript) {
    & "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ReportScript -InstallDirectory $InstallDirectory -OutputDirectory $dir -MaxFailures 100 -MaxEntries 100000 *> (Join-Path $dir 'report-command.txt')
    $exitCode = $LASTEXITCODE
    Add-Check "diagnostic-report-$Label" ($exitCode -eq 0) @{ exitCode = $exitCode }
    $report = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter report.json | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($report) { $script:ReportResults[$Label] = Get-Content -LiteralPath $report.FullName -Raw | ConvertFrom-Json }
  }
}

function Invoke-Installer([string]$Label, [string]$Installer, [string]$ExpectedVersion, [string]$TempDirectory) {
  $start = [DateTime]::UtcNow
  $info = [Diagnostics.ProcessStartInfo]::new($Installer)
  # NSIS /D 必须为最后一个未加引号的绝对路径，即便其中存在空格。
  $info.Arguments = "/S /D=$InstallDirectory"
  $info.UseShellExecute = $false
  $info.WorkingDirectory = Split-Path -Parent $Installer
  $info.Environment['TEMP'] = $TempDirectory
  $info.Environment['TMP'] = $TempDirectory
  $process = [Diagnostics.Process]::Start($info)
  Register-OwnedProcess $process $Label
  $deadline = $start.AddSeconds($InstallerTimeoutSeconds)
  do {
    Update-OwnedProcesses
    $activeChildren = @($script:Owned.Values | Where-Object { $_.operation -eq $Label -and -not $_.process.HasExited })
    $active = -not $process.HasExited -or $activeChildren.Count -gt 0
    if ($active) { Start-Sleep -Milliseconds 750 }
  } while ($active -and [DateTime]::UtcNow -lt $deadline)
  $timedOut = $active
  if ($timedOut) {
    Save-Diagnostics "$Label-timeout"
    Stop-OwnedProcesses
  }
  [void]$process.WaitForExit(5000)
  Update-OwnedProcesses
  $exitCode = if ($process.HasExited) { $process.ExitCode } else { $null }
  $state = Get-InstalledState
  $passed = -not $timedOut -and $exitCode -eq 0 -and $state.exeExists -and $state.uninstallerExists -and $state.packageVersion -eq $ExpectedVersion
  $record = [ordered]@{ name = $Label; startedAt = $start.ToString('o'); finishedAt = [DateTime]::UtcNow.ToString('o'); installer = $Installer; arguments = $info.Arguments; tempDirectory = $TempDirectory; tempLength = $TempDirectory.Length; processId = $process.Id; timedOut = $timedOut; exitCode = $exitCode; expectedPackageVersion = $ExpectedVersion; passed = $passed; installed = $state }
  $script:Steps.Add($record)
  Write-Json (Join-Path $OutputDirectory "$Label.json") $record
  Write-Host "$Label exit=$exitCode timeout=$timedOut package=$($state.packageVersion) passed=$passed"
  if (-not $passed) { Save-Diagnostics "$Label-failed" }
  $record
}

function Require-Passed($Step) {
  Add-Check $Step.name $Step.passed @{ exitCode = $Step.exitCode; packageVersion = $Step.installed.packageVersion }
  if (-not $Step.passed) { throw "Required control step failed: $($Step.name)" }
}

try {
  if (-not $IsWindows) { throw 'This diagnostic is Windows-only.' }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class InstallerDiagnosticWindows {
  private delegate bool EnumCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
  public static string[] ReadText(int processId) {
    var result = new List<string>();
    Action<IntPtr> collect = window => { var text = new StringBuilder(4096); GetWindowText(window, text, text.Capacity); if (text.Length > 0) result.Add(text.ToString()); };
    EnumWindows((window, parameter) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner == (uint)processId) {
        collect(window);
        EnumChildWindows(window, (child, ignored) => { collect(child); return true; }, IntPtr.Zero);
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator token required for per-machine NSIS install.' }
  if (@(Get-InstallRegistrations).Count -ne 0) { throw 'Runner already has a Floatboat registration; refusing to mix installation state.' }
  if (Test-Path -LiteralPath $InstallDirectory) { throw "Task installation directory already exists: $InstallDirectory" }
  New-Item -ItemType Directory -Path $ShortTemp, $LongTemp -Force | Out-Null
  $installerInfo = foreach ($path in @($InstallerRC4, $InstallerRC5)) {
    $file = Get-Item -LiteralPath $path
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $path ($($signature.Status))" }
    [ordered]@{ path = $path; size = $file.Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash; signatureStatus = [string]$signature.Status; signer = $signature.SignerCertificate.Subject; productVersion = $file.VersionInfo.ProductVersion; fileVersion = $file.VersionInfo.FileVersion }
  }
  Write-Json (Join-Path $OutputDirectory 'environment.json') @{ scenario = $Scenario; installDirectory = $InstallDirectory; shortTemp = $ShortTemp; longTemp = $LongTemp; os = [Environment]::OSVersion.VersionString; powershell = $PSVersionTable.PSVersion.ToString(); drives = @(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, DriveType, FileSystem, Size, FreeSpace); longPathsEnabled = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem').LongPathsEnabled; installers = @($installerInfo) }
  Require-Passed (Invoke-Installer '01-rc4-clean' $InstallerRC4 '0.6.3-rc.4' $ShortTemp)
  Save-Diagnostics '02-unlocked-control'
  $controlReport = $script:ReportResults['02-unlocked-control']
  $controlFailures = if ($controlReport) { @($controlReport.installations | ForEach-Object { $_.failures }) } else { @() }
  Add-Check 'report-unlocked-control' ($controlReport -and @($controlReport.installations).Count -eq 1 -and $controlFailures.Count -eq 0 -and @($controlReport.installations | Where-Object { -not $_.probeSummary.complete }).Count -eq 0) @{ failureCount = $controlFailures.Count }

  if ($Scenario -eq 'external-lock') {
    $lockedFile = Join-Path $InstallDirectory 'resources\app.asar'
    $readyFile = Join-Path $OutputDirectory 'lock-ready'
    $escapedTarget = $lockedFile.Replace("'", "''")
    $escapedReady = $readyFile.Replace("'", "''")
    $escapedRelease = $releaseLockFile.Replace("'", "''")
    $lockCode = @"
`$stream = [IO.File]::Open('$escapedTarget', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [IO.File]::WriteAllText('$escapedReady', [string]`$PID)
  `$deadline = [DateTime]::UtcNow.AddMinutes(15)
  while (-not [IO.File]::Exists('$escapedRelease') -and [DateTime]::UtcNow -lt `$deadline) { Start-Sleep -Milliseconds 250 }
} finally { `$stream.Dispose() }
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($lockCode))
    $lockInfo = [Diagnostics.ProcessStartInfo]::new("$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe", "-NoProfile -NonInteractive -EncodedCommand $encoded")
    $lockInfo.UseShellExecute = $false
    $lockProcess = [Diagnostics.Process]::Start($lockInfo)
    Register-OwnedProcess $lockProcess 'external-system-powershell-file-lock'
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $readyFile) -and [DateTime]::UtcNow -lt $readyDeadline -and -not $lockProcess.HasExited) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Path -LiteralPath $readyFile)) { throw 'External lock process did not acquire the intended file.' }
    Save-Diagnostics '03-external-lock-held'
    $lockReport = $script:ReportResults['03-external-lock-held']
    $matchingLock = if ($lockReport) { @($lockReport.installations | ForEach-Object { $_.failures } | Where-Object { $_.path -eq $lockedFile -and $_.win32ErrorCode -eq 32 }) } else { @() }
    Add-Check 'report-identifies-external-file-lock' ($matchingLock.Count -gt 0) @{ matches = $matchingLock }
    $lockedResult = Invoke-Installer '04-rc4-to-rc5-external-lock' $InstallerRC5 '0.6.3-rc.5' $ShortTemp
    # 刻画结果不预设必须失败；若安装器处理成功，同样保留实际证据。
    Add-Check 'external-lock-result-recorded' (-not $lockedResult.timedOut) @{ exitCode = $lockedResult.exitCode; upgradePassed = $lockedResult.passed }
    New-Item -ItemType File -Path $releaseLockFile -Force | Out-Null
    if (-not $lockProcess.WaitForExit(10000)) { throw 'Owned lock process failed to release its handle.' }
    Save-Diagnostics '05-external-lock-released'
    $releasedReport = $script:ReportResults['05-external-lock-released']
    $remainingLock = if ($releasedReport) { @($releasedReport.installations | ForEach-Object { $_.failures } | Where-Object { $_.path -eq $lockedFile -and $_.win32ErrorCode -eq 32 }) } else { @() }
    Add-Check 'report-clears-released-file-lock' ($releasedReport -and $remainingLock.Count -eq 0) @{ remainingLocks = $remainingLock.Count }
    Require-Passed (Invoke-Installer '06-rc5-retry-without-lock' $InstallerRC5 '0.6.3-rc.5' $ShortTemp)
  } elseif ($Scenario -eq 'long-temp') {
    $relativeFiles = @(Get-ChildItem -LiteralPath $InstallDirectory -Recurse -File | ForEach-Object { $_.FullName.Substring($InstallDirectory.Length + 1) })
    $overLimit = @($relativeFiles | Where-Object { ($LongTemp.Length + '\ns12345.tmp\old-install\'.Length + $_.Length) -gt 260 })
    Add-Check 'long-temp-reaches-old-install-path-limit' ($overLimit.Count -gt 0) @{ longTempLength = $LongTemp.Length; over260FileCount = $overLimit.Count; examples = @($overLimit | Select-Object -First 20) }
    if ($overLimit.Count -eq 0) { throw 'No installed file reaches the intended old-install path limit.' }
    $longResult = Invoke-Installer '03-rc4-to-rc5-long-temp' $InstallerRC5 '0.6.3-rc.5' $LongTemp
    Add-Check 'long-temp-result-recorded' (-not $longResult.timedOut) @{ exitCode = $longResult.exitCode; upgradePassed = $longResult.passed }
    Require-Passed (Invoke-Installer '04-rc5-retry-short-temp' $InstallerRC5 '0.6.3-rc.5' $ShortTemp)
  } else {
    Require-Passed (Invoke-Installer '03-rc4-same-version' $InstallerRC4 '0.6.3-rc.4' $ShortTemp)
    Require-Passed (Invoke-Installer '04-rc4-to-rc5' $InstallerRC5 '0.6.3-rc.5' $ShortTemp)
    Require-Passed (Invoke-Installer '05-rc5-same-version' $InstallerRC5 '0.6.3-rc.5' $ShortTemp)
  }
} catch {
  $script:Fatal = $_ | Out-String
  $script:Fatal | Set-Content -LiteralPath (Join-Path $OutputDirectory 'fatal.txt')
  Write-Warning $script:Fatal
} finally {
  New-Item -ItemType File -Path $releaseLockFile -Force | Out-Null
  try { Save-Diagnostics '99-final' } catch { $_ | Out-String | Set-Content -LiteralPath (Join-Path $OutputDirectory 'final-diagnostic-error.txt') }
  Stop-OwnedProcesses
  $processExitRecords = @($script:Owned.Values | ForEach-Object { [ordered]@{ processId = $_.processId; startTicks = $_.startTicks; reason = $_.reason; operation = $_.operation; path = $_.path; exitCode = $_.exitCode } })
  Write-Json (Join-Path $OutputDirectory 'results.json') @{ scenario = $Scenario; steps = @($script:Steps.ToArray()); checks = @($script:Checks.ToArray()); fatal = $script:Fatal; processes = $processExitRecords }
  $lines = @("## Windows installer regression: $Scenario", '', "Installation root: $InstallDirectory", '', '| Step | Exit | Timeout | Package version | Passed |', '| --- | --- | --- | --- | --- |')
  foreach ($step in $script:Steps) { $lines += "| $($step.name) | $($step.exitCode) | $($step.timedOut) | $($step.installed.packageVersion) | $($step.passed) |" }
  $lines += @('', '这是一次性 Windows runner 的刻画结果，不代表用户电脑已验收。')
  $lines | Set-Content -LiteralPath (Join-Path $OutputDirectory 'summary.md')
  if ($env:GITHUB_STEP_SUMMARY) { $lines | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY }
}
if ($script:Fatal -or @($script:Checks | Where-Object { -not $_.passed }).Count -gt 0) { exit 1 }
