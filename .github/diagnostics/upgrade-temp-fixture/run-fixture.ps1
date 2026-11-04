param(
  [Parameter(Mandatory = $true)][string] $HelperPath,
  [Parameter(Mandatory = $true)][string] $NsisRoot,
  [Parameter(Mandatory = $true)][string] $OutputDirectory,
  [switch] $InstrumentHelper
)
$ErrorActionPreference = 'Stop'
$helper = (Resolve-Path -LiteralPath $HelperPath).Path
$nsis = (Resolve-Path -LiteralPath $NsisRoot).Path
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) { throw 'Use a new fixture output directory.' }
$null = New-Item -ItemType Directory -Path $outputRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this isolated fixture in an elevated Windows session.'
}
$runId = [Guid]::NewGuid().ToString('N')
$installKey = "Software\FloatboatUpgradeTempFixture\$runId"
$uninstallKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\FloatboatUpgradeTempFixture-$runId"
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
$fixtureExecutable = Join-Path $outputRoot 'fixture.exe'
$oldNsisDir = [Environment]::GetEnvironmentVariable('NSISDIR', 'Process')
$ownedRegistryKeys = $false
$createdRoots = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$results = New-Object 'System.Collections.Generic.List[object]'
$cleanupFailures = New-Object 'System.Collections.Generic.List[string]'
$runFailure = $null

function Read-FixtureResult([string] $ResultPath) {
  if (-not (Test-Path -LiteralPath $ResultPath)) { throw "Missing fixture result: $ResultPath" }
  $result = @{}
  foreach ($line in [IO.File]::ReadAllLines($ResultPath, [Text.Encoding]::Unicode)) {
    $separator = $line.IndexOf('=')
    if ($separator -ge 0) { $result[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
  }
  return $result
}

try {
  if ($null -ne $registry.OpenSubKey($installKey) -or $null -ne $registry.OpenSubKey($uninstallKey)) {
    throw 'The isolated fixture registry key unexpectedly exists.'
  }
  $ownedRegistryKeys = $true
  [Environment]::SetEnvironmentVariable('NSISDIR', $nsis, 'Process')
  $compiler = Join-Path $nsis 'makensis.exe'
  if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $nsis 'Bin\makensis.exe' }
  $compiledHelper = $helper
  if ($InstrumentHelper) {
    $instrumentedLines = New-Object 'System.Collections.Generic.List[string]'
    $lineNumber = 0
    foreach ($line in [IO.File]::ReadAllLines($helper)) {
      $lineNumber++
      $instrumentedLines.Add($line)
      if ($line -match '^\s*System::Call ' -or $line -match '^\s*floatboat_upgrade_temp_(failed|restore_done):') {
        $instrumentedLines.Add('!insertmacro FixtureTrace "after-source-line-' + $lineNumber + '"')
      }
    }
    $compiledHelper = Join-Path $outputRoot 'instrumented-helper.nsh'
    [IO.File]::WriteAllLines($compiledHelper, $instrumentedLines.ToArray(), (New-Object Text.UTF8Encoding($false)))
  }
  $arguments = @(
    '/WX', '/INPUTCHARSET', 'UTF8', '/V3',
    "/DFIXTURE_OUT=$fixtureExecutable", "/DFIXTURE_HELPER=$compiledHelper",
    "/DFIXTURE_INSTALL_KEY=$installKey", "/DFIXTURE_UNINSTALL_KEY=$uninstallKey",
    (Join-Path $PSScriptRoot 'fixture.nsi')
  )
  if ($InstrumentHelper) { $arguments = @('/DFIXTURE_INSTRUMENTED') + $arguments }
  $compileLog = & $compiler @arguments 2>&1
  $compileExit = $LASTEXITCODE
  $compileLog | Out-String | Set-Content -LiteralPath (Join-Path $outputRoot 'compile.log') -Encoding UTF8
  if ($compileExit -ne 0) { throw "NSIS compilation failed with exit code $compileExit." }

  foreach ($mode in @('noop', 'values', 'undefined-temp', 'undefined-tmp', 'sentinel')) {
    $caseOutput = Join-Path $outputRoot $mode
    $null = New-Item -ItemType Directory -Path $caseOutput
    $originalTmp = Join-Path $caseOutput "original O'Brien TMP"
    $originalTemp = Join-Path $caseOutput 'original TEMP'
    $null = New-Item -ItemType Directory -Path $originalTmp
    $null = New-Item -ItemType Directory -Path $originalTemp
    $caseResult = [ordered]@{ mode = $mode; status = 'failed'; error = $null; result = $null; child = $null }
    try {
      if ($mode -ne 'noop') {
        $installation = $registry.CreateSubKey($installKey)
        try { $installation.SetValue('InstallLocation', (Join-Path $env:ProgramW6432 'FloatboatUpgradeTempFixture')) }
        finally { $installation.Dispose() }
        $uninstallation = $registry.CreateSubKey($uninstallKey)
        try { $uninstallation.SetValue('UninstallString', '"C:\FloatboatUpgradeTempFixture\Uninstall.exe"') }
        finally { $uninstallation.Dispose() }
      }
      $start = New-Object Diagnostics.ProcessStartInfo
      $start.FileName = $fixtureExecutable
      $start.Arguments = '/S'
      $start.WorkingDirectory = $caseOutput
      $start.UseShellExecute = $false
      $start.CreateNoWindow = $true
      $start.EnvironmentVariables['TMP'] = $originalTmp
      $start.EnvironmentVariables['TEMP'] = $originalTemp
      if ($mode -eq 'undefined-temp') { $start.EnvironmentVariables.Remove('TEMP') }
      if ($mode -eq 'undefined-tmp') { $start.EnvironmentVariables.Remove('TMP') }
      $start.EnvironmentVariables['FLOATBOAT_TEMP_FIXTURE_MODE'] = $mode
      $start.EnvironmentVariables['FLOATBOAT_TEMP_FIXTURE_OUTPUT'] = $caseOutput
      $start.EnvironmentVariables['FLOATBOAT_TEMP_FIXTURE_CHILD_SCRIPT'] = Join-Path $PSScriptRoot 'inspect-child.ps1'
      $process = New-Object Diagnostics.Process
      $process.StartInfo = $start
      try {
        if (-not $process.Start()) { throw 'Could not start the fixture executable.' }
        if (-not $process.WaitForExit(60000)) {
          $process.Kill()
          $process.WaitForExit()
          throw 'Fixture executable timed out.'
        }
        $exitCode = $process.ExitCode
      } finally { $process.Dispose() }
      $observed = Read-FixtureResult (Join-Path $caseOutput 'result.txt')
      $caseResult.result = $observed
      if (-not [string]::IsNullOrEmpty($observed.created_path)) { $null = $createdRoots.Add($observed.created_path) }
      if ($exitCode -ne 0 -or $observed.status -ne 'passed') { throw "Fixture exit ${exitCode}: $($observed.error)" }
      foreach ($name in @('tmp', 'temp')) {
        $expectedDefined = if ($mode -eq "undefined-$name") { '0' } else { '1' }
        $expectedValue = if ($expectedDefined -eq '0') { '' } elseif ($name -eq 'tmp') { $originalTmp } else { $originalTemp }
        if ($observed["original_${name}_defined"] -ne $expectedDefined -or
            $observed["original_$name"] -cne $expectedValue) {
          throw "The fixture did not receive the requested original $name environment."
        }
        if ($observed["original_${name}_defined"] -ne $observed["restored_${name}_defined"] -or
            $observed["original_$name"] -cne $observed["restored_$name"]) {
          throw "The original $name value or defined state was not restored."
        }
      }
      if ($mode -eq 'noop') {
        if (-not [string]::IsNullOrEmpty($observed.created_path)) { throw 'The no-op created a private directory.' }
      } else {
        $child = Get-Content -LiteralPath (Join-Path $caseOutput 'child.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $caseResult.child = $child
        if ($child.status -ne 'passed' -or $child.tmp -ne $observed.created_path -or $child.temp -ne $observed.created_path) {
          throw 'Child inheritance or ACL validation did not pass.'
        }
        if ($mode -eq 'sentinel') {
          if (-not (Test-Path -LiteralPath (Join-Path $observed.created_path 'sentinel.txt'))) {
            throw 'The non-empty private directory was deleted.'
          }
        } elseif (Test-Path -LiteralPath $observed.created_path) {
          throw 'The empty private directory remains after restore.'
        }
      }
      $caseResult.status = 'passed'
    } catch {
      $caseResult.error = $_.Exception.Message
      $partial = Join-Path $caseOutput 'result.txt'
      if (Test-Path -LiteralPath $partial) {
        $partialResult = Read-FixtureResult $partial
        if (-not [string]::IsNullOrEmpty($partialResult.created_path)) { $null = $createdRoots.Add($partialResult.created_path) }
      }
    } finally {
      $registry.DeleteSubKeyTree($uninstallKey, $false)
      $registry.DeleteSubKeyTree($installKey, $false)
    }
    $results.Add([pscustomobject]$caseResult)
  }
} catch { $runFailure = $_.Exception.Message }
finally {
  [Environment]::SetEnvironmentVariable('NSISDIR', $oldNsisDir, 'Process')
  if ($ownedRegistryKeys) {
    $registry.DeleteSubKeyTree($uninstallKey, $false)
    $registry.DeleteSubKeyTree($installKey, $false)
  }
  $registry.Dispose()
  foreach ($privateRoot in $createdRoots) {
    try {
      if (-not (Test-Path -LiteralPath $privateRoot)) { continue }
      $expectedParent = Join-Path $env:WINDIR 'Temp'
      if ([IO.Path]::GetDirectoryName($privateRoot) -ine $expectedParent -or
          [IO.Path]::GetFileName($privateRoot) -notmatch '^fb[0-9a-fA-F]{8}$') {
        throw "Refusing to clean an unexpected path: $privateRoot"
      }
      $sentinel = Join-Path $privateRoot 'sentinel.txt'
      if (Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel -Force }
      [IO.Directory]::Delete($privateRoot, $false)
    } catch { $cleanupFailures.Add($_.Exception.Message) }
  }
  [ordered]@{
    helperSha256 = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash
    instrumented = [bool]$InstrumentHelper
    runFailure = $runFailure
    cases = @($results.ToArray())
    cleanupFailures = @($cleanupFailures.ToArray())
  } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $outputRoot 'report.json') -Encoding UTF8
}
if ($null -ne $runFailure -or $results.Count -ne 5 -or
    @($results | Where-Object { $_.status -ne 'passed' }).Count -gt 0 -or $cleanupFailures.Count -gt 0) {
  throw "Upgrade temporary-folder fixture failed. See $outputRoot\report.json"
}
Write-Output "All 5 upgrade temporary-folder cases passed. Evidence: $outputRoot\report.json"
