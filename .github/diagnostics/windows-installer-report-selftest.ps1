#requires -Version 7.0
# ABOUTME: 验证 Windows PowerShell 5.1 的锁文件报告、重定向输出目录与安装目录边界。
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ReportScript,
  [Parameter(Mandatory)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows is required.' }
$fixtureRoot = Join-Path $env:RUNNER_TEMP ('floatboat-report-selftest-' + [Guid]::NewGuid().ToString('N'))
$fixture = Join-Path $fixtureRoot 'install'
$links = Join-Path $fixtureRoot 'links'
$outside = Join-Path $fixtureRoot 'outside'
New-Item -ItemType Directory -Path $fixture, $links, $outside, $OutputDirectory -Force | Out-Null
# 诊断只需要主程序路径标记；复制系统 EXE 保留合法版本资源，不运行这个文件。
Copy-Item -LiteralPath "$env:WINDIR\System32\notepad.exe" -Destination (Join-Path $fixture 'Floatboat.exe')
$target = Join-Path $fixture 'known-locked-file.txt'
'known diagnostic fixture' | Set-Content -LiteralPath $target
$legacyPowerShell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$summary = [Collections.Generic.List[object]]::new()
$junctions = [Collections.Generic.List[string]]::new()

function Invoke-Report([string]$Label, [string]$ParentDirectory = '') {
  if (-not $ParentDirectory) { $ParentDirectory = $OutputDirectory }
  $destination = Join-Path $ParentDirectory $Label
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  & $legacyPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ReportScript -InstallDirectory $fixture -OutputDirectory $destination -MaxSeconds 30 *> (Join-Path $destination 'command.txt')
  if ($LASTEXITCODE -ne 0) { throw "Report failed: $Label ($LASTEXITCODE)" }
  $json = Get-ChildItem -LiteralPath $destination -Recurse -File -Filter report.json | Select-Object -First 1
  if (-not $json) { throw "Report missing: $Label" }
  $report = Get-Content -LiteralPath $json.FullName -Raw | ConvertFrom-Json
  if (@($report.installations).Count -ne 1 -or -not $report.installations[0].probeSummary.complete) { throw "Incomplete report: $Label" }
  [pscustomobject]@{ installation = $report.installations[0]; report = $report; file = $json.FullName; requestedOutput = $destination; commandOutput = (Get-Content -LiteralPath (Join-Path $destination 'command.txt') -Raw) }
}

$stream = $null
$outsideStream = $null
try {
  $stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $locked = (Invoke-Report 'locked').installation
  $matches = @($locked.failures | Where-Object { $_.path -eq $target -and $_.win32ErrorCode -eq 32 })
  $summary.Add(@{ case = 'known-lock'; passed = ($matches.Count -gt 0); failureCount = $locked.probeSummary.failedCount; matchingErrors = $matches })
  if ($matches.Count -eq 0) { throw 'Report failed to identify known sharing violation (32).' }
  $stream.Dispose(); $stream = $null
  $unlocked = (Invoke-Report 'unlocked').installation
  $summary.Add(@{ case = 'released-lock'; passed = ($unlocked.probeSummary.failedCount -eq 0); failureCount = $unlocked.probeSummary.failedCount })
  if ($unlocked.probeSummary.failedCount -ne 0) { throw 'Report still claims a failure after the known lock is released.' }

  $realOutput = Join-Path $OutputDirectory 'redirected-desktop'
  New-Item -ItemType Directory -Path $realOutput -Force | Out-Null
  $outputLink = Join-Path $links 'Desktop'
  New-Item -ItemType Junction -Path $outputLink -Target $realOutput | Out-Null
  $junctions.Add($outputLink)
  $redirected = Invoke-Report 'output-junction' $outputLink
  $resolution = $redirected.report.outputPathResolution
  $expectedParent = [IO.Path]::GetFullPath((Join-Path $realOutput 'output-junction')).TrimEnd('\')
  $requestedParent = [IO.Path]::GetFullPath($redirected.requestedOutput).TrimEnd('\')
  $realJson = Get-ChildItem -LiteralPath $expectedParent -Recurse -File -Filter report.json | Select-Object -First 1
  $redirectedPassed = $resolution.requestedParent -eq $requestedParent -and $resolution.resolvedParent -eq $expectedParent -and $null -ne $realJson
  if ($realJson) { $redirectedPassed = $redirectedPassed -and $redirected.commandOutput.Contains($realJson.Directory.FullName) }
  $summary.Add(@{ case = 'output-parent-junction'; passed = $redirectedPassed; requested = $requestedParent; resolved = $resolution.resolvedParent; actualReport = $(if ($realJson) { $realJson.FullName } else { $null }) })
  if (-not $redirectedPassed) { throw 'Redirected output did not report its true filesystem location.' }

  $forbiddenOutput = Join-Path $links 'inside-install'
  New-Item -ItemType Junction -Path $forbiddenOutput -Target $fixture | Out-Null
  $junctions.Add($forbiddenOutput)
  $beforeDirectories = @(Get-ChildItem -LiteralPath $fixture -Directory).Count
  & $legacyPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ReportScript -InstallDirectory $fixture -OutputDirectory $forbiddenOutput -MaxSeconds 30 *> (Join-Path $OutputDirectory 'rejected-output-junction.txt')
  $rejectedCode = $LASTEXITCODE
  $afterDirectories = @(Get-ChildItem -LiteralPath $fixture -Directory).Count
  $rejectedOutput = Get-Content -LiteralPath (Join-Path $OutputDirectory 'rejected-output-junction.txt') -Raw
  $rejectedPassed = $rejectedCode -ne 0 -and $afterDirectories -eq $beforeDirectories -and $rejectedOutput.Contains('安装目录之外')
  $summary.Add(@{ case = 'reject-output-junction-into-install'; passed = $rejectedPassed; exitCode = $rejectedCode })
  if (-not $rejectedPassed) { throw 'Output junction into the installation directory was not rejected before writing.' }

  $outsideFile = Join-Path $outside 'must-not-be-scanned.txt'
  'outside installation boundary' | Set-Content -LiteralPath $outsideFile
  $outsideStream = [IO.File]::Open($outsideFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $nestedLink = Join-Path $fixture 'external-content'
  New-Item -ItemType Junction -Path $nestedLink -Target $outside | Out-Null
  $junctions.Add($nestedLink)
  $nested = (Invoke-Report 'skip-install-child-junction').installation
  $nestedPassed = $nested.probeSummary.skippedReparsePoints -eq 1 -and $nested.probeSummary.failedCount -eq 0
  $summary.Add(@{ case = 'skip-install-child-junction'; passed = $nestedPassed; skippedReparsePoints = $nested.probeSummary.skippedReparsePoints; failureCount = $nested.probeSummary.failedCount })
  if (-not $nestedPassed) { throw 'Report traversed or failed an installation child junction.' }
  Write-Host 'Windows PowerShell 5.1 report self-test passed: lock=32; released=0; output junction resolved; installation boundary preserved.'
} finally {
  if ($stream) { $stream.Dispose() }
  if ($outsideStream) { $outsideStream.Dispose() }
  $summary.ToArray() | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'selftest-results.json')
  # 先只删除任务创建的链接本身，随后才回收夹具，避免递归进入证据目录。
  foreach ($junction in $junctions) { Remove-Item -LiteralPath $junction -Force -ErrorAction SilentlyContinue }
  $remainingJunctions = @($junctions | Where-Object { Test-Path -LiteralPath $_ })
  if ($remainingJunctions.Count -eq 0) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
