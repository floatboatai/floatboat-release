#requires -Version 7.0
# ABOUTME: 用已知文件共享锁快速验证诊断脚本在 Windows PowerShell 5.1 上报告错误 32，并在释放后恢复。
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ReportScript,
  [Parameter(Mandatory)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows is required.' }
$fixture = Join-Path $env:RUNNER_TEMP ('floatboat-report-selftest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture, $OutputDirectory -Force | Out-Null
# 诊断只需要主程序路径标记；复制系统 EXE 保留合法版本资源，不运行这个文件。
Copy-Item -LiteralPath "$env:WINDIR\System32\notepad.exe" -Destination (Join-Path $fixture 'Floatboat.exe')
$target = Join-Path $fixture 'known-locked-file.txt'
'known diagnostic fixture' | Set-Content -LiteralPath $target
$legacyPowerShell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$summary = [Collections.Generic.List[object]]::new()

function Invoke-Report([string]$Label) {
  $destination = Join-Path $OutputDirectory $Label
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  & $legacyPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ReportScript -InstallDirectory $fixture -OutputDirectory $destination -MaxSeconds 30 *> (Join-Path $destination 'command.txt')
  if ($LASTEXITCODE -ne 0) { throw "Report failed: $Label ($LASTEXITCODE)" }
  $json = Get-ChildItem -LiteralPath $destination -Recurse -File -Filter report.json | Select-Object -First 1
  if (-not $json) { throw "Report missing: $Label" }
  $report = Get-Content -LiteralPath $json.FullName -Raw | ConvertFrom-Json
  if (@($report.installations).Count -ne 1 -or -not $report.installations[0].probeSummary.complete) { throw "Incomplete report: $Label" }
  $report.installations[0]
}

$stream = $null
try {
  $stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $locked = Invoke-Report 'locked'
  $matches = @($locked.failures | Where-Object { $_.path -eq $target -and $_.win32ErrorCode -eq 32 })
  $summary.Add(@{ case = 'known-lock'; passed = ($matches.Count -gt 0); failureCount = $locked.probeSummary.failedCount; matchingErrors = $matches })
  if ($matches.Count -eq 0) { throw 'Report failed to identify known sharing violation (32).' }
  $stream.Dispose(); $stream = $null
  $unlocked = Invoke-Report 'unlocked'
  $summary.Add(@{ case = 'released-lock'; passed = ($unlocked.probeSummary.failedCount -eq 0); failureCount = $unlocked.probeSummary.failedCount })
  if ($unlocked.probeSummary.failedCount -ne 0) { throw 'Report still claims a failure after the known lock is released.' }
  Write-Host 'Windows PowerShell 5.1 report self-test passed: lock=32; released=0.'
} finally {
  if ($stream) { $stream.Dispose() }
  $summary.ToArray() | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'selftest-results.json')
  # fixture 是本任务新建的唯一目录；诊断证据已单独保存。
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
