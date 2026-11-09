# ABOUTME: 在一次性 Windows runner 上真实调用 Windows PowerShell 5.1，验证基线登记清理及拒绝边界。
#requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Only an isolated GitHub-hosted Windows runner is supported.' }
$scriptPath = Join-Path $PSScriptRoot 'Build-Registry.ps1'
$testRoot = Join-Path $env:RUNNER_TEMP ('floatboat-registry-test-' + [Guid]::NewGuid().ToString('N'))
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser','Registry64')
$fixtures = [Collections.Generic.List[object]]::new()
$passed = 0

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-WindowsPowerShell([string[]]$Arguments, [bool]$ExpectSuccess) {
  $start = [Diagnostics.ProcessStartInfo]::new('powershell.exe')
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  # 不能把 pwsh 7 的模块目录传给 Windows PowerShell 5.1。
  $null = $start.Environment.Remove('PSModulePath')
  foreach ($argument in @('-NoLogo','-NoProfile','-NonInteractive') + $Arguments) { $start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    Assert ($process.Start()) 'Could not start Windows PowerShell.'
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'Windows PowerShell test timed out.' }
    $text = $stdout.GetAwaiter().GetResult()
    $errorText = $stderr.GetAwaiter().GetResult()
    Assert (($process.ExitCode -eq 0) -eq $ExpectSuccess) "Unexpected Windows PowerShell exit $($process.ExitCode): $text $errorText"
    return [pscustomobject]@{ output=$text;error=$errorText;exitCode=$process.ExitCode }
  } finally { $process.Dispose() }
}
function New-Fixture {
  $guid = [Guid]::NewGuid().ToString()
  $paths = @(('Software\' + $guid), ('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $guid))
  foreach ($keyPath in $paths) {
    $existing = $base.OpenSubKey($keyPath)
    try { Assert ($null -eq $existing) "Fixture registry key already exists: $keyPath" }
    finally { if ($null -ne $existing) { $existing.Dispose() } }
  }
  $directory = Join-Path $testRoot $guid
  $owned = Join-Path $directory 'baseline-installer'
  $null = [IO.Directory]::CreateDirectory($owned)
  $fixture = [pscustomobject]@{ guid=$guid;paths=$paths;owned=$owned;receipt=(Join-Path $directory 'before.json') }
  $fixtures.Add($fixture)
  $inspection = Invoke-WindowsPowerShell @('-File',$scriptPath,'-Action','Inspect','-Guid',$guid) $true
  [IO.File]::WriteAllText($fixture.receipt,$inspection.output)
  $records = @($inspection.output | ConvertFrom-Json)
  Assert ($records.Count -eq 2 -and @($records | Where-Object exists).Count -eq 0) 'Fixture inspection did not prove two absent keys.'
  return $fixture
}
function Add-FixtureKeys($Fixture, [string]$UninstallDirectory) {
  $key = $base.CreateSubKey($Fixture.paths[0])
  try { $key.SetValue('InstallLocation',$Fixture.owned) } finally { $key.Dispose() }
  $key = $base.CreateSubKey($Fixture.paths[1])
  try { $key.SetValue('UninstallString',('"' + (Join-Path $UninstallDirectory 'Uninstall Floatboat.exe') + '" /allusers')) } finally { $key.Dispose() }
}
function Assert-Keys($Fixture, [bool]$Expected) {
  foreach ($keyPath in $Fixture.paths) {
    $key = $base.OpenSubKey($keyPath)
    try { Assert (($null -ne $key) -eq $Expected) "Unexpected key state after cleanup: $keyPath" }
    finally { if ($null -ne $key) { $key.Dispose() } }
  }
}
function Cleanup-Fixture($Fixture, [bool]$ExpectSuccess) {
  return Invoke-WindowsPowerShell @('-File',$scriptPath,'-Action','Cleanup','-Guid',$Fixture.guid,'-OwnedBuildDirectory',$Fixture.owned,'-BeforeReceipt',$Fixture.receipt) $ExpectSuccess
}

try {
  $version = Invoke-WindowsPowerShell @('-Command','$PSVersionTable.PSVersion.ToString()') $true
  Assert ($version.output.Trim().StartsWith('5.1.')) 'The regression must exercise Windows PowerShell 5.1.'

  $fixture = New-Fixture
  $null = Cleanup-Fixture $fixture $true
  Assert-Keys $fixture $false
  $passed++

  $fixture = New-Fixture
  Add-FixtureKeys $fixture $fixture.owned
  $null = Cleanup-Fixture $fixture $true
  Assert-Keys $fixture $false
  $passed++

  foreach ($invalid in @('duplicate','unknown','preexisting','nonboolean','arraypath')) {
    $fixture = New-Fixture
    Add-FixtureKeys $fixture $fixture.owned
    $records = @((Get-Content -LiteralPath $fixture.receipt -Raw | ConvertFrom-Json))
    switch ($invalid) {
      duplicate { $records[1].path = $records[0].path }
      unknown { $records[1].path = 'Software\unowned-fixture' }
      preexisting { $records[1].exists = $true }
      nonboolean { $records[1].exists = 'false' }
      arraypath { $records[0].path = $fixture.paths; $records[1].path = 'Software\unowned-fixture' }
    }
    [IO.File]::WriteAllText($fixture.receipt,(ConvertTo-Json -InputObject $records -Depth 8))
    $result = Cleanup-Fixture $fixture $false
    Assert ($result.error.Contains('Before receipt does not prove both exact keys were absent.')) "Unexpected refusal for $invalid"
    Assert-Keys $fixture $true
    $passed++
  }

  $fixture = New-Fixture
  Add-FixtureKeys $fixture ($fixture.owned + '-outside')
  $result = Cleanup-Fixture $fixture $false
  Assert ($result.error.Contains('Build key is outside owned output:')) 'Outside path was not rejected.'
  # 第二个键越界时，第一个合法键也必须保留，证明先验证全部来源再删除。
  Assert-Keys $fixture $true
  $passed++

  $fixture = New-Fixture
  Add-FixtureKeys $fixture $fixture.owned
  $key = $base.OpenSubKey($fixture.paths[1],$true)
  try { $key.DeleteValue('UninstallString') } finally { $key.Dispose() }
  $result = Cleanup-Fixture $fixture $false
  Assert ($result.error.Contains('Build key has no proven output path:')) 'Unknown output path was not rejected.'
  Assert-Keys $fixture $true
  $passed++

  Write-Output "Windows PowerShell 5.1 registry cleanup regression: $passed passed."
} finally {
  # 仅清理测试开始时已证明不存在、且用随机 GUID 创建的 fixture 键。
  foreach ($fixture in $fixtures) {
    foreach ($keyPath in $fixture.paths) { $base.DeleteSubKeyTree($keyPath,$false) }
  }
  $base.Dispose()
  if ([IO.Directory]::Exists($testRoot)) { [IO.Directory]::Delete($testRoot,$true) }
}
