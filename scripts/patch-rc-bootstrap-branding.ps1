param(
  [string]$InstallerDir = "floatboat-installer\win",
  [string]$AssetsDir = ".floatboat-release\installer-assets\windows\bootstrap",
  [int]$LaunchDelayMs = 1500
)

$ErrorActionPreference = "Stop"

$nsiPath = Join-Path $InstallerDir "bootstrap-installer.nsi"
$downloadScriptPath = Join-Path $InstallerDir "download-installer.ps1"
$setupProgressScriptPath = "build\setup-progress-monitor.ps1"
$welcomeAssetPath = Join-Path $AssetsDir "welcome-product.bmp"
$targetWelcomeAssetPath = Join-Path $InstallerDir "bootstrap-welcome-product.bmp"
$utf8Bom = New-Object System.Text.UTF8Encoding -ArgumentList $true
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false

function Read-TextFile([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8BomFile([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, $utf8Bom)
}

function Write-Utf8NoBomFile([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Convert-Newlines([string]$Content, [string]$Newline) {
  return ($Content -replace "\r?\n", $Newline)
}

function Patch-AtomicWriter(
  [string]$ScriptPath,
  [string]$OldBlock,
  [string]$NewBlock,
  [string]$RequiredSnippet,
  [bool]$WriteBom
) {
  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "Script not found: $ScriptPath"
  }

  $source = Read-TextFile -Path $ScriptPath
  if ($source.Contains($RequiredSnippet)) {
    return
  }

  $newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }
  $oldNormalized = Convert-Newlines -Content $OldBlock -Newline $newline
  $newNormalized = Convert-Newlines -Content $NewBlock -Newline $newline

  if (-not $source.Contains($oldNormalized)) {
    throw "Unable to patch Write-Atomic in $ScriptPath"
  }

  $source = $source.Replace($oldNormalized, $newNormalized)
  if ($WriteBom) {
    Write-Utf8BomFile -Path $ScriptPath -Content $source
  } else {
    Write-Utf8NoBomFile -Path $ScriptPath -Content $source
  }
}

if (-not (Test-Path -LiteralPath $nsiPath)) {
  throw "NSIS bootstrap script not found: $nsiPath"
}

if (-not (Test-Path -LiteralPath $welcomeAssetPath)) {
  throw "RC bootstrap welcome image not found: $welcomeAssetPath"
}

Copy-Item -LiteralPath $welcomeAssetPath -Destination $targetWelcomeAssetPath -Force

$source = Read-TextFile -Path $nsiPath
$newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }

if (-not $source.Contains('!define MUI_WELCOMEFINISHPAGE_BITMAP "bootstrap-welcome-product.bmp"')) {
  $source = $source.Replace(
    '!define MUI_UNICON "..\..\resources\icon.ico"',
    "!define MUI_UNICON `"..\..\resources\icon.ico`"${newline}!define MUI_WELCOMEFINISHPAGE_BITMAP `"bootstrap-welcome-product.bmp`""
  )
}

if (-not $source.Contains("LangString TXT_READY_TO_LAUNCH")) {
  $source = $source.Replace(
    'LangString TXT_LAUNCHING ${LANG_SIMPCHINESE} "正在启动完整安装器..."',
    "LangString TXT_LAUNCHING `${LANG_SIMPCHINESE} `"正在启动完整安装器...`"${newline}LangString TXT_READY_TO_LAUNCH `${LANG_ENGLISH} `"Download complete. Opening the full installer...`"${newline}LangString TXT_READY_TO_LAUNCH `${LANG_SIMPCHINESE} `"下载完成，正在打开完整安装器...`""
  )
}

$newDownloadDone = @"
  !insertmacro RefreshDownloadUi
  SendMessage `$ProgressBarHandle `${PBM_SETPOS} 10000 0
  DetailPrint "`$(TXT_READY_TO_LAUNCH)"

  !insertmacro SendEvent "download_complete"

  Sleep $LaunchDelayMs
  DetailPrint "`$(TXT_LAUNCHING)"
"@

$downloadDonePattern = '(?m)^  SendMessage \$ProgressBarHandle \$\{PBM_SETPOS\} 10000 0\r?\n  DetailPrint "\$\(TXT_VERIFYING\)"\r?\n\r?\n  !insertmacro SendEvent "download_complete"\r?\n\r?\n  DetailPrint "\$\(TXT_LAUNCHING\)"'

if ([regex]::IsMatch($source, $downloadDonePattern)) {
  $source = [regex]::Replace(
    $source,
    $downloadDonePattern,
    [System.Text.RegularExpressions.MatchEvaluator] { param($match) $newDownloadDone.TrimEnd() },
    1
  )
} elseif (-not $source.Contains('DetailPrint "$(TXT_READY_TO_LAUNCH)"')) {
  throw "Unable to patch DownloadDone completion state in $nsiPath"
}

$oldFailureMessage = 'MessageBox MB_ICONSTOP|MB_OK "$(TXT_DOWNLOAD_FAILED_GENERIC)$\r$\n$(TXT_DOWNLOAD_ATTEMPTS_EXHAUSTED)"'
$newFailureMessage = 'MessageBox MB_ICONSTOP|MB_OK "$(TXT_DOWNLOAD_FAILED_GENERIC)$\r$\n$(TXT_DOWNLOAD_ATTEMPTS_EXHAUSTED)$\r$\n$\r$\n$DownloadResult"'

if ($source.Contains($oldFailureMessage)) {
  $source = $source.Replace($oldFailureMessage, $newFailureMessage)
} elseif (-not $source.Contains('$DownloadResult"')) {
  throw "Unable to patch download failure message in $nsiPath"
}

$requiredSnippets = @(
  '!define MUI_WELCOMEFINISHPAGE_BITMAP "bootstrap-welcome-product.bmp"',
  'LangString TXT_READY_TO_LAUNCH',
  'DetailPrint "$(TXT_READY_TO_LAUNCH)"',
  '$DownloadResult"'
)

foreach ($snippet in $requiredSnippets) {
  if (-not $source.Contains($snippet)) {
    throw "RC bootstrap patch is incomplete; missing snippet: $snippet"
  }
}

Write-Utf8BomFile -Path $nsiPath -Content $source

$oldDownloadWriteAtomic = @'
function Write-Atomic([string]$Path, [string]$Content, [System.Text.Encoding]$Encoding) {
  $tmpPath = "$Path.tmp"
  [System.IO.File]::WriteAllText($tmpPath, $Content, $Encoding)
  Move-Item -LiteralPath $tmpPath -Destination $Path -Force
}
'@

$newDownloadWriteAtomic = @'
function Write-Atomic([string]$Path, [string]$Content, [System.Text.Encoding]$Encoding) {
  $parentDirectory = Split-Path -Parent $Path
  if ($parentDirectory -and -not (Test-Path -LiteralPath $parentDirectory)) {
    [System.IO.Directory]::CreateDirectory($parentDirectory) | Out-Null
  }

  $tmpPath = '{0}.{1}.{2}.tmp' -f $Path, $PID, ([System.Guid]::NewGuid().ToString('N'))
  [System.IO.File]::WriteAllText($tmpPath, $Content, $Encoding)

  $lastError = $null
  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    try {
      if ([System.IO.File]::Exists($Path)) {
        [System.IO.File]::Replace($tmpPath, $Path, $null, $true)
      } else {
        [System.IO.File]::Move($tmpPath, $Path)
      }
      return
    } catch [System.IO.IOException] {
      $lastError = $_
      Start-Sleep -Milliseconds 25
    } catch [System.UnauthorizedAccessException] {
      $lastError = $_
      Start-Sleep -Milliseconds 25
    }
  }

  Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
  if ($null -ne $lastError) {
    throw $lastError.Exception
  }
}
'@

Patch-AtomicWriter `
  -ScriptPath $downloadScriptPath `
  -OldBlock $oldDownloadWriteAtomic `
  -NewBlock $newDownloadWriteAtomic `
  -RequiredSnippet '[System.IO.File]::Replace($tmpPath, $Path, $null, $true)' `
  -WriteBom $true

$oldSetupProgressWriteAtomic = @'
function Write-Atomic([string]$Path, [string]$Content, [System.Text.Encoding]$Encoding) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  Ensure-ParentDirectory -Path $Path
  $temporaryPath = "$Path.tmp"
  [System.IO.File]::WriteAllText($temporaryPath, $Content, $Encoding)
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}
'@

$newSetupProgressWriteAtomic = @'
function Write-Atomic([string]$Path, [string]$Content, [System.Text.Encoding]$Encoding) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  Ensure-ParentDirectory -Path $Path
  $temporaryPath = '{0}.{1}.{2}.tmp' -f $Path, $PID, ([System.Guid]::NewGuid().ToString('N'))
  [System.IO.File]::WriteAllText($temporaryPath, $Content, $Encoding)

  $lastError = $null
  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    try {
      if ([System.IO.File]::Exists($Path)) {
        [System.IO.File]::Replace($temporaryPath, $Path, $null, $true)
      } else {
        [System.IO.File]::Move($temporaryPath, $Path)
      }
      return
    } catch [System.IO.IOException] {
      $lastError = $_
      Start-Sleep -Milliseconds 25
    } catch [System.UnauthorizedAccessException] {
      $lastError = $_
      Start-Sleep -Milliseconds 25
    }
  }

  Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  if ($null -ne $lastError) {
    throw $lastError.Exception
  }
}
'@

Patch-AtomicWriter `
  -ScriptPath $setupProgressScriptPath `
  -OldBlock $oldSetupProgressWriteAtomic `
  -NewBlock $newSetupProgressWriteAtomic `
  -RequiredSnippet '[System.IO.File]::Replace($temporaryPath, $Path, $null, $true)' `
  -WriteBom $false

Write-Host "Prepared RC bootstrap branding:"
Write-Host "  installer script: $nsiPath"
Write-Host "  downloader script: $downloadScriptPath"
Write-Host "  setup progress script: $setupProgressScriptPath"
Write-Host "  welcome image:    $targetWelcomeAssetPath"
Write-Host "  launch delay:     ${LaunchDelayMs}ms"
