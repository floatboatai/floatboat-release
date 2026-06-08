param(
  [string]$InstallerDir = "floatboat-installer\win",
  [string]$AssetsDir = ".floatboat-release\installer-assets\windows\bootstrap",
  [int]$LaunchDelayMs = 1500
)

$ErrorActionPreference = "Stop"

$nsiPath = Join-Path $InstallerDir "bootstrap-installer.nsi"
$downloadScriptPath = Join-Path $InstallerDir "download-installer.ps1"
$setupProgressScriptPath = "build\setup-progress-monitor.ps1"
$assetPath = Join-Path $AssetsDir "product-panel.bmp"
$targetAssetPath = Join-Path $InstallerDir "bootstrap-product-panel.bmp"
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

if (-not (Test-Path -LiteralPath $nsiPath)) {
  throw "NSIS bootstrap script not found: $nsiPath"
}

if (-not (Test-Path -LiteralPath $downloadScriptPath)) {
  throw "Bootstrap downloader script not found: $downloadScriptPath"
}

if (-not (Test-Path -LiteralPath $assetPath)) {
  throw "RC bootstrap product panel not found: $assetPath"
}

Copy-Item -LiteralPath $assetPath -Destination $targetAssetPath -Force

$source = Read-TextFile -Path $nsiPath
$newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }

if (-not $source.Contains('!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow')) {
  $source = $source.Replace(
    "!insertmacro MUI_PAGE_WELCOME${newline}!insertmacro MUI_PAGE_INSTFILES",
    "!insertmacro MUI_PAGE_WELCOME${newline}!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow${newline}!insertmacro MUI_PAGE_INSTFILES"
  )
}

if (-not $source.Contains("LangString TXT_READY_TO_LAUNCH")) {
  $source = $source.Replace(
    'LangString TXT_LAUNCHING ${LANG_SIMPCHINESE} "正在启动完整安装器..."',
    "LangString TXT_LAUNCHING `${LANG_SIMPCHINESE} `"正在启动完整安装器...`"${newline}LangString TXT_READY_TO_LAUNCH `${LANG_ENGLISH} `"Download complete. Opening the full installer...`"${newline}LangString TXT_READY_TO_LAUNCH `${LANG_SIMPCHINESE} `"下载完成，正在打开完整安装器...`""
  )
}

if (-not $source.Contains("Var ProductPanelDialogHandle")) {
  $source = $source.Replace(
    "Var DownloadPollEmptyTicks",
    "Var DownloadPollEmptyTicks${newline}Var ProductPanelDialogHandle${newline}Var ProductPanelHandle${newline}Var ProductPanelBitmap"
  )
}

if (-not $source.Contains("Function BootstrapInstFilesShow")) {
  $functionBlock = @"

!define FLOATBOAT_PRODUCT_PANEL_STYLE 0x5000000E
!define FLOATBOAT_IMAGE_BITMAP 0
!define FLOATBOAT_LR_LOADFROMFILE 0x00000010
!define FLOATBOAT_STM_SETIMAGE 0x0172
!define FLOATBOAT_SW_HIDE 0

Function BootstrapFindInstFilesControls
  FindWindow `$ProductPanelDialogHandle "#32770" "" `$HWNDPARENT
  `${If} `$ProductPanelDialogHandle != 0
    GetDlgItem `$ProgressBarHandle `$ProductPanelDialogHandle 1004
  `${EndIf}
FunctionEnd

Function BootstrapWaitForInstFilesControls
  StrCpy `$R8 0

  _bootstrapInstFilesControlWaitLoop:
    Call BootstrapFindInstFilesControls
    `${If} `$ProductPanelDialogHandle != 0
    `${AndIf} `$ProgressBarHandle != 0
      Return
    `${EndIf}

    IntOp `$R8 `$R8 + 1
    `${If} `$R8 < 30
      Sleep 80
      Goto _bootstrapInstFilesControlWaitLoop
    `${EndIf}
FunctionEnd

Function BootstrapInstFilesShow
  InitPluginsDir
  File /oname=`$PLUGINSDIR\bootstrap-product-panel.bmp "bootstrap-product-panel.bmp"

  Call BootstrapWaitForInstFilesControls
  `${If} `$ProductPanelDialogHandle == 0
    Return
  `${EndIf}

  GetDlgItem `$0 `$ProductPanelDialogHandle 1006
  `${If} `$0 != 0
    System::Call 'USER32::ShowWindow(p `$0, i `${FLOATBOAT_SW_HIDE})'
  `${EndIf}

  GetDlgItem `$0 `$ProductPanelDialogHandle 1016
  `${If} `$0 != 0
    System::Call 'USER32::MoveWindow(p `$0, i 18, i 208, i 438, i 34, i 1)'
  `${EndIf}

  `${If} `$ProgressBarHandle != 0
    System::Call 'USER32::MoveWindow(p `$ProgressBarHandle, i 18, i 184, i 438, i 14, i 1)'
  `${EndIf}

  System::Call 'USER32::CreateWindowEx(i 0, t "STATIC", t "", i `${FLOATBOAT_PRODUCT_PANEL_STYLE}, i 18, i 12, i 438, i 160, p `$ProductPanelDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy `$ProductPanelHandle `$0
  `${If} `$ProductPanelHandle == 0
    Return
  `${EndIf}

  System::Call 'USER32::LoadImage(p 0, t "`$PLUGINSDIR\bootstrap-product-panel.bmp", i `${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i `${FLOATBOAT_LR_LOADFROMFILE}) p.r0'
  StrCpy `$ProductPanelBitmap `$0
  `${If} `$ProductPanelBitmap != 0
    SendMessage `$ProductPanelHandle `${FLOATBOAT_STM_SETIMAGE} `${FLOATBOAT_IMAGE_BITMAP} `$ProductPanelBitmap
  `${EndIf}
FunctionEnd

Function BootstrapDestroyProductPanel
  `${If} `$ProductPanelHandle != ""
  `${AndIf} `$ProductPanelHandle != 0
    System::Call 'USER32::DestroyWindow(p `$ProductPanelHandle)'
    StrCpy `$ProductPanelHandle ""
  `${EndIf}

  `${If} `$ProductPanelBitmap != ""
  `${AndIf} `$ProductPanelBitmap != 0
    System::Call 'GDI32::DeleteObject(p `$ProductPanelBitmap)'
    StrCpy `$ProductPanelBitmap ""
  `${EndIf}
FunctionEnd
"@

  $source = $source.Replace(
    "Function BootstrapAbortCleanup",
    "$functionBlock${newline}Function BootstrapAbortCleanup"
  )
}

if (-not $source.Contains("Call BootstrapDestroyProductPanel${newline}${newline}  `${If} `$DownloadPidFile")) {
  $source = $source.Replace(
    "Function BootstrapAbortCleanup${newline}  `${If} `$DownloadPidFile",
    "Function BootstrapAbortCleanup${newline}  Call BootstrapDestroyProductPanel${newline}${newline}  `${If} `$DownloadPidFile"
  )
}

if ($source.Contains("GetDlgItem `$ProgressBarHandle `$HWNDPARENT 1004")) {
  $source = $source.Replace(
    "GetDlgItem `$ProgressBarHandle `$HWNDPARENT 1004",
    "Call BootstrapFindInstFilesControls"
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

if (-not $source.Contains("Call BootstrapDestroyProductPanel${newline}  Quit")) {
  $oldExecQuit = '  Exec ''"$DownloadedExe"''' + $newline + '  Quit'
  $newExecQuit = '  Exec ''"$DownloadedExe"''' + $newline + '  Call BootstrapDestroyProductPanel' + $newline + '  Quit'
  $source = $source.Replace(
    $oldExecQuit,
    $newExecQuit
  )
}

$oldFailureMessage = 'MessageBox MB_ICONSTOP|MB_OK "$(TXT_DOWNLOAD_FAILED_GENERIC)$\r$\n$(TXT_DOWNLOAD_ATTEMPTS_EXHAUSTED)"'
$newFailureMessage = 'MessageBox MB_ICONSTOP|MB_OK "$(TXT_DOWNLOAD_FAILED_GENERIC)$\r$\n$(TXT_DOWNLOAD_ATTEMPTS_EXHAUSTED)$\r$\n$\r$\n$DownloadResult"'

if ($source.Contains($oldFailureMessage)) {
  $source = $source.Replace($oldFailureMessage, $newFailureMessage)
} elseif (-not $source.Contains('$DownloadResult"')) {
  throw "Unable to patch download failure message in $nsiPath"
}

$requiredSnippets = @(
  '!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow',
  'LangString TXT_READY_TO_LAUNCH',
  'Var ProductPanelDialogHandle',
  'Var ProductPanelHandle',
  'Function BootstrapFindInstFilesControls',
  'Function BootstrapInstFilesShow',
  'Call BootstrapFindInstFilesControls',
  'DetailPrint "$(TXT_READY_TO_LAUNCH)"',
  '$DownloadResult"'
)

foreach ($snippet in $requiredSnippets) {
  if (-not $source.Contains($snippet)) {
    throw "RC bootstrap branding patch is incomplete; missing snippet: $snippet"
  }
}

Write-Utf8BomFile -Path $nsiPath -Content $source

$downloadSource = Read-TextFile -Path $downloadScriptPath
if (-not $downloadSource.Contains('[System.IO.File]::Replace($tmpPath, $Path, $null, $true)')) {
  $downloadNewline = if ($downloadSource.Contains("`r`n")) { "`r`n" } else { "`n" }
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

  $oldDownloadWriteAtomic = Convert-Newlines -Content $oldDownloadWriteAtomic -Newline $downloadNewline
  $newDownloadWriteAtomic = Convert-Newlines -Content $newDownloadWriteAtomic -Newline $downloadNewline

  if (-not $downloadSource.Contains($oldDownloadWriteAtomic)) {
    throw "Unable to patch Write-Atomic in $downloadScriptPath"
  }
  $downloadSource = $downloadSource.Replace($oldDownloadWriteAtomic, $newDownloadWriteAtomic)
  Write-Utf8BomFile -Path $downloadScriptPath -Content $downloadSource
}

if (Test-Path -LiteralPath $setupProgressScriptPath) {
  $setupProgressSource = Read-TextFile -Path $setupProgressScriptPath
  if (-not $setupProgressSource.Contains('[System.IO.File]::Replace($temporaryPath, $Path, $null, $true)')) {
    $setupProgressNewline = if ($setupProgressSource.Contains("`r`n")) { "`r`n" } else { "`n" }
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

    $oldSetupProgressWriteAtomic = Convert-Newlines -Content $oldSetupProgressWriteAtomic -Newline $setupProgressNewline
    $newSetupProgressWriteAtomic = Convert-Newlines -Content $newSetupProgressWriteAtomic -Newline $setupProgressNewline

    if (-not $setupProgressSource.Contains($oldSetupProgressWriteAtomic)) {
      throw "Unable to patch Write-Atomic in $setupProgressScriptPath"
    }
    $setupProgressSource = $setupProgressSource.Replace($oldSetupProgressWriteAtomic, $newSetupProgressWriteAtomic)
    Write-Utf8NoBomFile -Path $setupProgressScriptPath -Content $setupProgressSource
  }
}

Write-Host "Prepared RC bootstrap branding:"
Write-Host "  installer script: $nsiPath"
Write-Host "  downloader script: $downloadScriptPath"
Write-Host "  setup progress script: $setupProgressScriptPath"
Write-Host "  product panel:    $targetAssetPath"
Write-Host "  launch delay:     ${LaunchDelayMs}ms"
