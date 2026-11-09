# ABOUTME: 只处理本轮基线构建创建的两个精确 HKCU 键；已有键由调用方拒绝，来源不明的键保留并报错。
param(
  [Parameter(Mandatory)][ValidateSet('Inspect','Cleanup')][string]$Action,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9-]{36}$')][string]$Guid,
  [string]$OwnedBuildDirectory,
  [string]$BeforeReceipt
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Only an isolated GitHub-hosted Windows runner is supported.' }
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser','Registry64')
$paths = @(('Software\' + $Guid), ('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $Guid))
$records = @()
try {
  foreach ($keyPath in $paths) {
    $key = $base.OpenSubKey($keyPath)
    try {
      $values = @{}
      if ($null -ne $key) { foreach ($name in $key.GetValueNames()) { $values[$name] = $key.GetValue($name) } }
      $records += [pscustomobject]@{ path=$keyPath; exists=($null -ne $key); values=$values }
    } finally { if ($null -ne $key) { $key.Dispose() } }
  }
  if ($Action -eq 'Cleanup') {
    if ([string]::IsNullOrWhiteSpace($OwnedBuildDirectory) -or [string]::IsNullOrWhiteSpace($BeforeReceipt)) { throw 'Cleanup requires an owned directory and the before receipt.' }
    # Windows PowerShell 5.1 将 JSON 顶层数组作为单个管道对象输出，先接收再展开才能按记录计数。
    $beforeJson = Get-Content -LiteralPath $BeforeReceipt -Raw | ConvertFrom-Json
    $before = @($beforeJson)
    $validBefore = $before.Count -eq $paths.Count
    foreach ($keyPath in $paths) {
      $matchingRecords = @($before | Where-Object { $_.path -is [string] -and $_.path -ceq $keyPath })
      if ($matchingRecords.Count -ne 1 -or $matchingRecords[0].exists -isnot [bool] -or $matchingRecords[0].exists -ne $false) { $validBefore = $false }
    }
    if (-not $validBefore) { throw 'Before receipt does not prove both exact keys were absent.' }
    $owned = [IO.Path]::GetFullPath($OwnedBuildDirectory).TrimEnd('\')
    # 先验证全部键再删除；卸载键不一定有 InstallLocation，按其标准 UninstallString 绑定实际输出目录。
    foreach ($record in $records) {
      if (-not $record.exists) { continue }
      $location = [string]$record.values['InstallLocation']
      if ([string]::IsNullOrWhiteSpace($location)) {
        $command = [string]$record.values['UninstallString']
        if ($record.path -ne $paths[1] -or $command -notmatch '^"([^"\r\n]+)"(?:\s|$)') { throw "Build key has no proven output path: $($record.path)" }
        $location = [IO.Path]::GetDirectoryName($Matches[1])
      }
      $location = [IO.Path]::GetFullPath($location).TrimEnd('\')
      if ($location -ine $owned -and -not $location.StartsWith($owned+'\',[StringComparison]::OrdinalIgnoreCase)) { throw "Build key is outside owned output: $($record.path)" }
    }
    foreach ($record in $records) { if ($record.exists) { $base.DeleteSubKeyTree($record.path,$false) } }
  }
  ConvertTo-Json -InputObject $records -Depth 8 -Compress
} finally { $base.Dispose() }
