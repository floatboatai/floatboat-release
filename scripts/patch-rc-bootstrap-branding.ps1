param(
  [string]$InstallerDir = "floatboat-installer\win",
  [string]$AssetsDir = ".floatboat-release\installer-assets\windows\bootstrap",
  [int]$LaunchDelayMs = 1500
)

$ErrorActionPreference = "Stop"

$nsiPath = Join-Path $InstallerDir "bootstrap-installer.nsi"
$assetPath = Join-Path $AssetsDir "product-panel.bmp"
$targetAssetPath = Join-Path $InstallerDir "bootstrap-product-panel.bmp"

if (-not (Test-Path -LiteralPath $nsiPath)) {
  throw "NSIS bootstrap script not found: $nsiPath"
}

if (-not (Test-Path -LiteralPath $assetPath)) {
  throw "RC bootstrap product panel not found: $assetPath"
}

Copy-Item -LiteralPath $assetPath -Destination $targetAssetPath -Force

$source = Get-Content -LiteralPath $nsiPath -Raw -Encoding UTF8
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

if (-not $source.Contains("Var ProductPanelHandle")) {
  $source = $source.Replace(
    "Var DownloadPollEmptyTicks",
    "Var DownloadPollEmptyTicks${newline}Var ProductPanelHandle${newline}Var ProductPanelBitmap"
  )
}

if (-not $source.Contains("Function BootstrapInstFilesShow")) {
  $functionBlock = @"

!define FLOATBOAT_PRODUCT_PANEL_STYLE 0x5000000E
!define FLOATBOAT_IMAGE_BITMAP 0
!define FLOATBOAT_LR_LOADFROMFILE 0x00000010
!define FLOATBOAT_STM_SETIMAGE 0x0172

Function BootstrapInstFilesShow
  InitPluginsDir
  File /oname=`$PLUGINSDIR\bootstrap-product-panel.bmp "bootstrap-product-panel.bmp"

  System::Call 'user32::LoadImageW(p 0, w "`$PLUGINSDIR\bootstrap-product-panel.bmp", i `${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i `${FLOATBOAT_LR_LOADFROMFILE}) p.r0'
  StrCpy `$ProductPanelBitmap `$0

  `${If} `$ProductPanelBitmap != 0
    GetDlgItem `$0 `$HWNDPARENT 1016
    `${If} `$0 != 0
      System::Call 'user32::MoveWindow(p `$0, i 30, i 238, i 438, i 54, i 1)'
    `${EndIf}

    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i `${FLOATBOAT_PRODUCT_PANEL_STYLE}, i 30, i 72, i 438, i 160, p `$HWNDPARENT, p 0, p 0, p 0) p.r0'
    StrCpy `$ProductPanelHandle `$0
    `${If} `$ProductPanelHandle != 0
      SendMessage `$ProductPanelHandle `${FLOATBOAT_STM_SETIMAGE} `${FLOATBOAT_IMAGE_BITMAP} `$ProductPanelBitmap
    `${EndIf}
  `${EndIf}
FunctionEnd
"@

  $source = $source.Replace(
    "Function BootstrapAbortCleanup",
    "$functionBlock${newline}Function BootstrapAbortCleanup"
  )
}

$oldDownloadDone = @"
  SendMessage `$ProgressBarHandle `${PBM_SETPOS} 10000 0
  DetailPrint "`$(TXT_VERIFYING)"

  !insertmacro SendEvent "download_complete"

  DetailPrint "`$(TXT_LAUNCHING)"
"@

$newDownloadDone = @"
  !insertmacro RefreshDownloadUi
  SendMessage `$ProgressBarHandle `${PBM_SETPOS} 10000 0
  DetailPrint "`$(TXT_READY_TO_LAUNCH)"

  !insertmacro SendEvent "download_complete"

  Sleep $LaunchDelayMs
  DetailPrint "`$(TXT_LAUNCHING)"
"@

if ($source.Contains($oldDownloadDone)) {
  $source = $source.Replace($oldDownloadDone, $newDownloadDone)
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
  '!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow',
  'LangString TXT_READY_TO_LAUNCH',
  'Var ProductPanelHandle',
  'Function BootstrapInstFilesShow',
  'DetailPrint "$(TXT_READY_TO_LAUNCH)"',
  '$DownloadResult"'
)

foreach ($snippet in $requiredSnippets) {
  if (-not $source.Contains($snippet)) {
    throw "RC bootstrap branding patch is incomplete; missing snippet: $snippet"
  }
}

Set-Content -LiteralPath $nsiPath -Value $source -Encoding UTF8

Write-Host "Prepared RC bootstrap branding:"
Write-Host "  installer script: $nsiPath"
Write-Host "  product panel:    $targetAssetPath"
Write-Host "  launch delay:     ${LaunchDelayMs}ms"
