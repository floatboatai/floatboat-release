# ABOUTME: 只读采集 Windows 覆盖安装线索，检查旧安装目录的 DELETE 访问与共享冲突，不执行卸载或修复。
#requires -Version 5.1
<#
.SYNOPSIS
生成 Floatboat Windows 安装诊断摘要和 JSON。
.EXAMPLE
powershell.exe -NoProfile -File .\windows-installer-report.ps1 -InstallDirectory 'C:\Program Files\Floatboat' -OutputDirectory 'C:\Users\me\Desktop'
.NOTES
OutputDirectory 是报告父目录；每次创建独立子目录，默认使用桌面。
请在错误出现时运行；管理员运行能看到更多进程和注册表项，但权限上下文可能与原安装器不同。
仅读取匹配产品的卸载项、安装目录元数据和进程 PID/路径；不读取文件正文、命令行或完整环境。
只写报告及 Add-Type 所需的临时编译文件；不删除/移动文件、不杀进程、不修改注册表。
CreateFileW 官方契约：https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
最终路径契约：https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew
#>
[CmdletBinding()]
param(
    [string]$InstallDirectory,
    [string]$OutputDirectory = [Environment]::GetFolderPath('Desktop'),
    [ValidateRange(1, 1000)][int]$MaxFailures = 100,
    [ValidateRange(1, 500000)][int]$MaxEntries = 100000,
    [ValidateRange(1, 600)][int]$MaxSeconds = 120
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw '此脚本仅支持 Windows。' }
$startedAt = [DateTimeOffset]::Now
$notes = New-Object 'System.Collections.Generic.List[string]'
$registryEntries = New-Object 'System.Collections.Generic.List[object]'
$candidates = New-Object 'System.Collections.Generic.List[object]'
$installations = New-Object 'System.Collections.Generic.List[object]'

function Get-LocalAbsolutePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]') {
        throw '只接受本地盘符开头的绝对路径，不接受相对路径、UNC 或设备路径。'
    }
    if ($Value.Substring(2) -match '[:*?"<>|]' -or $Value -match '[\x00-\x1f]') { throw '路径含不支持的字符。' }
    return [IO.Path]::GetFullPath($Value.Replace('/', '\')).TrimEnd('\')
}

function Test-WithinDirectory([string]$Path, [string]$Directory) {
    return $Path.Equals($Directory, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($Directory + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparseAncestor([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            $attributes = [IO.File]::GetAttributes($cursor)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '路径含重解析点，已拒绝遍历。' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (!$parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-ErrorName([int]$Code) {
    switch ($Code) {
        0 { return 'SUCCESS' }
        2 { return 'ERROR_FILE_NOT_FOUND' }
        3 { return 'ERROR_PATH_NOT_FOUND' }
        5 { return 'ERROR_ACCESS_DENIED' }
        32 { return 'ERROR_SHARING_VIOLATION' }
        33 { return 'ERROR_LOCK_VIOLATION' }
        123 { return 'ERROR_INVALID_NAME' }
        206 { return 'ERROR_FILENAME_EXCED_RANGE' }
        303 { return 'ERROR_DELETE_PENDING' }
        default { return 'WIN32_ERROR_' + $Code }
    }
}

function Get-DiskSummary([string]$Directory) {
    try {
        $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($Directory))
        return [pscustomobject]@{ root = $drive.Name; availableBytes = $drive.AvailableFreeSpace; totalBytes = $drive.TotalSize }
    } catch { return [pscustomobject]@{ root = [IO.Path]::GetPathRoot($Directory); availableBytes = $null; unavailable = $true } }
}

# 只保留明确匹配 Floatboat 发行产品的条目；不保存 UninstallString 的参数。
$uninstallKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
foreach ($hiveName in @('LocalMachine', 'CurrentUser')) {
    foreach ($viewName in @('Registry64', 'Registry32')) {
        $baseKey = $null
        $parentKey = $null
        try {
            $hive = [Microsoft.Win32.RegistryHive]::$hiveName
            $view = [Microsoft.Win32.RegistryView]::$viewName
            $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            $parentKey = $baseKey.OpenSubKey($uninstallKey, $false)
            if ($null -eq $parentKey) { continue }
            foreach ($keyName in $parentKey.GetSubKeyNames()) {
                $entryKey = $null
                try {
                    $entryKey = $parentKey.OpenSubKey($keyName, $false)
                    if ($null -eq $entryKey) { continue }
                    $displayName = [string]$entryKey.GetValue('DisplayName', '')
                    if ($displayName -notmatch '^Floatboat(?: DeepSeek Agent)?(?:\s+\d[0-9A-Za-z. -]*)?$') { continue }
                    $location = [string]$entryKey.GetValue('InstallLocation', '')
                    if (!$location) {
                        $uninstall = [string]$entryKey.GetValue('UninstallString', '')
                        if ($uninstall -match '^"([^"\r\n]+\\Uninstall Floatboat(?:DeepSeekAgent| DeepSeek Agent)?\.exe)"(?:\s|$)') {
                            $location = [IO.Path]::GetDirectoryName($Matches[1])
                        }
                    }
                    $record = [pscustomobject]@{
                        hive = $hiveName; view = $viewName; key = $keyName; displayName = $displayName
                        displayVersion = [string]$entryKey.GetValue('DisplayVersion', ''); installDirectory = $location
                    }
                    $registryEntries.Add($record)
                    if ($location) { $candidates.Add([pscustomobject]@{ path = $location; source = 'registry' }) }
                } catch { $notes.Add("读取 $hiveName/$viewName 的某个卸载项失败；该项未采集。") }
                finally { if ($null -ne $entryKey) { $entryKey.Dispose() } }
            }
        } catch { $notes.Add("无法读取 $hiveName/$viewName 卸载列表。") }
        finally {
            if ($null -ne $parentKey) { $parentKey.Dispose() }
            if ($null -ne $baseKey) { $baseKey.Dispose() }
        }
    }
}
if ($InstallDirectory) {
    $candidates.Clear()
    $candidates.Add([pscustomobject]@{ path = $InstallDirectory; source = 'argument' })
}
if ($candidates.Count -eq 0) {
    $candidates.Add([pscustomobject]@{ path = 'C:\Program Files\Floatboat'; source = 'confirmed-default' })
}

$protectedDirectories = @(
    $env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData,
    $env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA, [IO.Path]::GetTempPath(),
    [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments')
)
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($candidate in $candidates) {
    try {
        $directory = Get-LocalAbsolutePath $candidate.path
        if (!$seen.Add($directory)) { continue }
        if ($directory.Length -le 3) { throw '不允许扫描盘符根目录。' }
        foreach ($protected in $protectedDirectories) {
            if ($protected -and (Test-WithinDirectory (Get-LocalAbsolutePath $protected) $directory)) {
                throw '不允许扫描用户、系统、临时目录或其上级目录。'
            }
        }
        Assert-NoReparseAncestor $directory
        if (![IO.Directory]::Exists($directory)) { throw '目录不存在或无法访问。' }
        $mainFile = $null
        foreach ($name in @('Floatboat.exe', 'FloatboatDeepSeekAgent.exe', 'Uninstall Floatboat.exe', 'Uninstall FloatboatDeepSeekAgent.exe', 'Uninstall Floatboat DeepSeek Agent.exe')) {
            $possible = Join-Path $directory $name
            if ([IO.File]::Exists($possible)) { $mainFile = $possible; break }
        }
        if (!$mainFile) { throw '目录内没有 Floatboat 主程序或卸载程序，已拒绝扫描。' }
        Assert-NoReparseAncestor $mainFile
        $fileVersion = $null
        $productVersion = $null
        try {
            $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($mainFile)
            $fileVersion = $versionInfo.FileVersion
            $productVersion = $versionInfo.ProductVersion
        }
        catch { $notes.Add("无法读取 '$mainFile' 的版本，继续探测目录。") }
        $installations.Add([pscustomobject]@{
            directory = $directory; source = $candidate.source; versionSource = $mainFile
            fileVersion = $fileVersion; productVersion = $productVersion
            disk = Get-DiskSummary $directory; processes = @(); probeSummary = $null; failures = @(); longPaths = $null
        })
    } catch { $notes.Add("跳过安装目录 '$($candidate.path)'：$($_.Exception.Message)") }
}

# DELETE 只声明请求的访问权；OPEN_EXISTING 不创建文件，也绝不设置 DELETE_ON_CLOSE。
# BACKUP_SEMANTICS 允许打开目录；OPEN_REPARSE_POINT 避免对末级链接目标进行探测。
if (-not ('FloatboatInstallerDiagnostics.NativeProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace FloatboatInstallerDiagnostics {
    public static class NativeProbe {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
            IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
            StringBuilder path, uint capacity, uint flags);
        public static string ResolveDirectory(string name) {
            using (SafeFileHandle handle = CreateFileW(name, 0, 7,
                IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                StringBuilder path = new StringBuilder(512);
                uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
                if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (length >= path.Capacity) {
                    path = new StringBuilder(checked((int)length + 1));
                    length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
                    if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (length >= path.Capacity) throw new Win32Exception(122);
                }
                return path.ToString();
            }
        }
        public static int ProbeDeleteAccess(string name) {
            using (SafeFileHandle handle = CreateFileW(name, 0x00010000, 0x00000007,
                IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
            }
        }
    }
}
'@
}

# 报告父目录是明确选定的写入位置，允许其重定向；只解析一次已有祖先，不枚举链接目标。
# 最终路径仍须为本地盘符路径，并在解析后重新检查安装目录边界。
function Resolve-ReportParent([string]$RequestedPath) {
    $cursor = $RequestedPath
    $missingSegments = New-Object 'System.Collections.Generic.Stack[string]'
    while (![IO.Directory]::Exists($cursor)) {
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (!$parent -or $parent -eq $cursor) { throw '报告父目录不存在或无法访问。' }
        $missingSegments.Push([IO.Path]::GetFileName($cursor))
        $cursor = $parent
    }
    $resolved = [FloatboatInstallerDiagnostics.NativeProbe]::ResolveDirectory($cursor)
    if ($resolved.StartsWith('\\?\', [StringComparison]::Ordinal)) { $resolved = $resolved.Substring(4) }
    $resolved = Get-LocalAbsolutePath $resolved
    while ($missingSegments.Count -gt 0) { $resolved = [IO.Path]::Combine($resolved + '\', $missingSegments.Pop()) }
    return $resolved
}

if (!$OutputDirectory) { throw '桌面目录不可用，请通过 -OutputDirectory 指定报告父目录。' }
$requestedOutputParent = Get-LocalAbsolutePath $OutputDirectory
if ($requestedOutputParent.Length -le 3) { throw '请勿把报告父目录设为盘符根目录。' }
$outputParent = Resolve-ReportParent $requestedOutputParent
if ($outputParent.Length -le 3) { throw '请勿把报告父目录设为盘符根目录。' }
foreach ($installation in $installations) {
    if (Test-WithinDirectory $outputParent $installation.directory) { throw '报告目录必须位于安装目录之外。' }
}
$reportDirectory = Join-Path $outputParent ('floatboat-installer-report-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
[void][IO.Directory]::CreateDirectory($reportDirectory)
$temporaryDirectory = [IO.Path]::GetTempPath()

# 只投影 PID 与可执行文件路径；外部程序持有的句柄不会出现在这份安装目录进程列表中。
$processQuery = [ordered]@{ status = 'pending'; durationMs = 0; errorType = $null; errorCode = $null }
$processQueryWatch = [Diagnostics.Stopwatch]::StartNew()
try {
    Get-CimInstance -Query 'SELECT ProcessId, ExecutablePath FROM Win32_Process' -OperationTimeoutSec 15 | ForEach-Object {
        $item = $_
        if ($item.ExecutablePath) {
            foreach ($installation in $installations) {
                if (Test-WithinDirectory ([string]$item.ExecutablePath) $installation.directory) {
                    $installation.processes += [pscustomobject]@{ processId = $item.ProcessId; executablePath = $item.ExecutablePath }
                }
            }
        }
    }
    $processQuery.status = 'success'
} catch {
    $queryError = $_.Exception.GetBaseException()
    $processQuery.status = 'error'
    $processQuery.errorType = $queryError.GetType().FullName
    $processQuery.errorCode = $queryError.HResult
    $notes.Add('进程查询失败或不完整；未能读取的进程路径不会列入报告。')
} finally {
    $processQueryWatch.Stop()
    $processQuery.durationMs = $processQueryWatch.ElapsedMilliseconds
}

foreach ($installation in $installations) {
    $failures = New-Object 'System.Collections.Generic.List[object]'
    $longPathExamples = New-Object 'System.Collections.Generic.List[object]'
    $queue = New-Object 'System.Collections.Generic.Stack[object]'
    $queue.Push([pscustomobject]@{ path = $installation.directory; depth = 0 })
    $summary = [ordered]@{ scannedCount = 0; succeededCount = 0; failedCount = 0; skippedReparsePoints = 0; complete = $true; stopReason = $null }
    $longPaths = [ordered]@{ longestSourceLength = 0; longestSourcePath = $null; longestProjectedTemporaryLength = 0; projectedOver260Count = 0; examples = @() }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($queue.Count -gt 0) {
        if ($summary.scannedCount -ge $MaxEntries -or $failures.Count -ge $MaxFailures -or $watch.Elapsed.TotalSeconds -ge $MaxSeconds) {
            $summary.complete = $false; $summary.stopReason = '达到条目数、失败数或时间上限'; break
        }
        $next = $queue.Pop()
        $currentPath = [string]$next.path
        if (!(Test-WithinDirectory $currentPath $installation.directory)) { throw '拒绝越过安装目录边界。' }
        $operation = 'metadata'
        try {
            $relativePath = $currentPath.Substring($installation.directory.Length).TrimStart('\')
            $projected = Join-Path $temporaryDirectory 'nsXXXX.tmp\old-install'
            if ($relativePath) { $projected = Join-Path $projected $relativePath }
            if ($currentPath.Length -gt $longPaths.longestSourceLength) {
                $longPaths.longestSourceLength = $currentPath.Length; $longPaths.longestSourcePath = $currentPath
            }
            $longPaths.longestProjectedTemporaryLength = [Math]::Max($longPaths.longestProjectedTemporaryLength, $projected.Length)
            if ($projected.Length -ge 260) {
                $longPaths.projectedOver260Count++
                if ($longPathExamples.Count -lt 10) { $longPathExamples.Add([pscustomobject]@{ path = $currentPath; sourceLength = $currentPath.Length; projectedTemporaryPath = $projected; projectedLength = $projected.Length }) }
            }
            Assert-NoReparseAncestor $currentPath
            $attributes = [IO.File]::GetAttributes($currentPath)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $summary.skippedReparsePoints++; continue }
            $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
            $summary.scannedCount++
            $operation = 'delete-access'
            $errorCode = [FloatboatInstallerDiagnostics.NativeProbe]::ProbeDeleteAccess($currentPath)
            if ($errorCode -eq 0) { $summary.succeededCount++ }
            else { $failures.Add([pscustomobject]@{ path = $currentPath; operation = $operation; isDirectory = $isDirectory; readOnlyAttribute = (($attributes -band [IO.FileAttributes]::ReadOnly) -ne 0); win32ErrorCode = $errorCode; win32ErrorName = Get-ErrorName $errorCode }) }
            if ($isDirectory) {
                if ($next.depth -ge 60) { $summary.complete = $false; $summary.stopReason = '部分目录超过 60 层，已跳过'; continue }
                $operation = 'enumerate'
                $enumerator = [IO.Directory]::EnumerateFileSystemEntries($currentPath).GetEnumerator()
                try {
                    while ($enumerator.MoveNext()) {
                        if ($queue.Count + $summary.scannedCount -ge $MaxEntries -or $watch.Elapsed.TotalSeconds -ge $MaxSeconds) {
                            $summary.complete = $false; $summary.stopReason = '达到条目数或时间上限，枚举已截断'; break
                        }
                        $queue.Push([pscustomobject]@{ path = [string]$enumerator.Current; depth = $next.depth + 1 })
                    }
                } finally { $enumerator.Dispose() }
            }
        } catch {
            if ($_.Exception.Message -eq '路径含重解析点，已拒绝遍历。') { $summary.skippedReparsePoints++; continue }
            $code = $_.Exception.GetBaseException().HResult -band 0xffff
            $failures.Add([pscustomobject]@{ path = $currentPath; operation = $operation; win32ErrorCode = $code; win32ErrorName = Get-ErrorName $code })
            $summary.complete = $false
        }
    }
    $watch.Stop()
    $summary.failedCount = $failures.Count
    $longPaths.examples = @($longPathExamples.ToArray())
    $installation.probeSummary = [pscustomobject]$summary
    $installation.failures = @($failures.ToArray())
    $installation.longPaths = [pscustomobject]$longPaths
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $elevated = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
finally { $identity.Dispose() }
$report = [ordered]@{
    schemaVersion = 1; startedAt = $startedAt.ToString('o'); completedAt = [DateTimeOffset]::Now.ToString('o')
    windowsVersion = [Environment]::OSVersion.VersionString; powerShellVersion = $PSVersionTable.PSVersion.ToString()
    is64BitOperatingSystem = [Environment]::Is64BitOperatingSystem; elevated = $elevated
    temporaryDirectory = $temporaryDirectory; temporaryDisk = Get-DiskSummary $temporaryDirectory
    outputPathResolution = @{ requestedParent = $requestedOutputParent; resolvedParent = $outputParent; reportDirectory = $reportDirectory }
    processQuery = [pscustomobject]$processQuery
    limits = @{ maxEntries = $MaxEntries; maxFailures = $MaxFailures; maxSeconds = $MaxSeconds; maxDepth = 60 }
    registryEntries = @($registryEntries.ToArray()); installations = @($installations.ToArray()); notes = @($notes.ToArray())
    limitations = @(
        '旧卸载器返回 2 可来自初始化退出、取消、文件占用、权限或其他失败，不能仅凭退出码确定原因。',
        'DELETE 访问探测仅反映当前进程权限和当前瞬间的源路径状态；成功不保证目标临时目录可写、同卷重命名成功或后续不被安全软件阻止。',
        '本脚本不找出持有句柄的具体进程；安装目录外的进程也可能占用被探测文件。',
        '临时路径使用 nsXXXX.tmp 占位估算；超过 260 字符只是旧卸载器兼容性线索，不是确定原因。',
        '不遍历重解析点；运行中目录或文件仍可能变化，报告不是原子快照。'
    )
}
$lines = New-Object 'System.Collections.Generic.List[string]'
$lines.Add('Floatboat Windows 覆盖安装诊断（只读）')
$lines.Add("生成时间：$($report.completedAt)；管理员上下文：$elevated")
$lines.Add("报告父目录（指定）：$requestedOutputParent")
$lines.Add("报告父目录（实际）：$outputParent")
$lines.Add("TEMP：$temporaryDirectory；可用字节：$($report.temporaryDisk.availableBytes)")
$lines.Add("匹配卸载项：$($registryEntries.Count)；实际扫描安装目录：$($installations.Count)")
$lines.Add("进程查询状态：$($processQuery.status)；耗时：$($processQuery.durationMs) ms；错误类型：$($processQuery.errorType)；错误码（HRESULT）：$($processQuery.errorCode)")
foreach ($installation in $installations) {
    $s = $installation.probeSummary
    $lines.Add('')
    $lines.Add("安装目录：$($installation.directory)；产品版本：$($installation.productVersion)；文件版本：$($installation.fileVersion)")
    $lines.Add("扫描 $($s.scannedCount) 项；DELETE 访问成功 $($s.succeededCount) 项；失败/不可访问 $($s.failedCount) 项；跳过重解析点 $($s.skippedReparsePoints) 项；完成：$($s.complete)")
    if ($s.stopReason) { $lines.Add("范围限制：$($s.stopReason)") }
    $lines.Add("安装目录内正在运行的进程：$($installation.processes.Count)；最长源路径 $($installation.longPaths.longestSourceLength) 字符；TEMP 投影最长 $($installation.longPaths.longestProjectedTemporaryLength) 字符")
    foreach ($failure in $installation.failures) { $lines.Add("[$($failure.win32ErrorName) / $($failure.win32ErrorCode)] $($failure.operation) $($failure.path)") }
    if ($s.failedCount -eq 0) { $lines.Add('当前扫描范围未发现访问失败；这不排除旧卸载器初始化错误、目的地限制或稍后出现的文件占用。') }
}
$lines.Add('')
$lines.Add('32 / ERROR_SHARING_VIOLATION：现有句柄不允许 DELETE 共享；5 / ERROR_ACCESS_DENIED：当前权限/文件属性/安全策略可能不允许该访问。')
foreach ($note in $notes) { $lines.Add('提示：' + $note) }
foreach ($limitation in $report.limitations) { $lines.Add('边界：' + $limitation) }
$utf8 = New-Object Text.UTF8Encoding $true
[IO.File]::WriteAllText((Join-Path $reportDirectory 'report.json'), ($report | ConvertTo-Json -Depth 10), $utf8)
[IO.File]::WriteAllLines((Join-Path $reportDirectory 'summary.txt'), $lines.ToArray(), $utf8)
Write-Host ($lines -join [Environment]::NewLine)
Write-Host "报告目录：$reportDirectory"
Write-Output $reportDirectory
