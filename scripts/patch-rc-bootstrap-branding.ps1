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
$carouselAssets = @(
  @{ Source = (Join-Path $AssetsDir "carousel-work.bmp"); Target = (Join-Path $InstallerDir "bootstrap-carousel-1.bmp") },
  @{ Source = (Join-Path $AssetsDir "carousel-combo.bmp"); Target = (Join-Path $InstallerDir "bootstrap-carousel-2.bmp") },
  @{ Source = (Join-Path $AssetsDir "carousel-tacit.bmp"); Target = (Join-Path $InstallerDir "bootstrap-carousel-3.bmp") }
)
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
foreach ($asset in $carouselAssets) {
  if (-not (Test-Path -LiteralPath $asset.Source)) {
    throw "RC bootstrap carousel image not found: $($asset.Source)"
  }

  Copy-Item -LiteralPath $asset.Source -Destination $asset.Target -Force
}

$source = Read-TextFile -Path $nsiPath
$newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }

if (-not $source.Contains('!define MUI_WELCOMEFINISHPAGE_BITMAP "bootstrap-welcome-product.bmp"')) {
  $source = $source.Replace(
    '!define MUI_UNICON "..\..\resources\icon.ico"',
    "!define MUI_UNICON `"..\..\resources\icon.ico`"${newline}!define MUI_WELCOMEFINISHPAGE_BITMAP `"bootstrap-welcome-product.bmp`""
  )
}

if ($source.Contains('BrandingText "Floatboat Web Installer"')) {
  $source = $source.Replace('BrandingText "Floatboat Web Installer"', 'BrandingText " "')
}

if (-not $source.Contains("LangString TXT_READY_TO_LAUNCH")) {
  $source = $source.Replace(
    'LangString TXT_LAUNCHING ${LANG_SIMPCHINESE} "正在启动完整安装器..."',
    "LangString TXT_LAUNCHING `${LANG_SIMPCHINESE} `"正在启动完整安装器...`"${newline}LangString TXT_READY_TO_LAUNCH `${LANG_ENGLISH} `"Download complete. Opening the full installer...`"${newline}LangString TXT_READY_TO_LAUNCH `${LANG_SIMPCHINESE} `"下载完成，正在打开完整安装器...`""
  )
}

if (-not $source.Contains('!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow')) {
  $source = $source.Replace(
    "!insertmacro MUI_PAGE_WELCOME${newline}!insertmacro MUI_PAGE_INSTFILES",
    "!insertmacro MUI_PAGE_WELCOME${newline}!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow${newline}!insertmacro MUI_PAGE_INSTFILES"
  )
}

if (-not $source.Contains("Var DownloadLastProgressValue")) {
  $source = $source.Replace(
    "Var DownloadPollEmptyTicks",
    "Var DownloadPollEmptyTicks${newline}Var DownloadLastProgressValue${newline}Var DownloadLastStateValue${newline}Var DownloadStateStableTicks"
  )
}

if (-not $source.Contains("Var BootstrapPageDialogHandle")) {
  $source = $source.Replace(
    "Var DownloadPollEmptyTicks",
    "Var DownloadPollEmptyTicks${newline}Var BootstrapPageDialogHandle${newline}Var BootstrapImageHandle${newline}Var BootstrapTitleHandle${newline}Var BootstrapSubtitleHandle${newline}Var BootstrapStatusHandle${newline}Var BootstrapMetaHandle${newline}Var BootstrapPercentHandle${newline}Var BootstrapHintHandle${newline}Var ProductCarouselBitmap1${newline}Var ProductCarouselBitmap2${newline}Var ProductCarouselBitmap3${newline}Var ProductCarouselFrame${newline}Var ProductCarouselTick"
  )
}

if (-not $source.Contains("Function BootstrapInstFilesShow")) {
  $functionBlock = Convert-Newlines -Newline $newline -Content @'

!define FLOATBOAT_CHILD_VISIBLE 0x50000000
!define FLOATBOAT_STATIC_BITMAP_STYLE 0x5000000E
!define FLOATBOAT_STATIC_TEXT_STYLE 0x50000000
!define FLOATBOAT_STATIC_CENTER_STYLE 0x50000001
!define FLOATBOAT_STATIC_RIGHT_STYLE 0x50000002
!define FLOATBOAT_PROGRESS_STYLE 0x50000000
!define FLOATBOAT_IMAGE_BITMAP 0
!define FLOATBOAT_LR_LOADFROMFILE 0x00000010
!define FLOATBOAT_LR_CREATEDIBSECTION 0x00002000
!define FLOATBOAT_LR_BITMAP_FLAGS 0x00002010
!define FLOATBOAT_STM_SETIMAGE 0x0172
!define FLOATBOAT_WINDOW_WIDTH 700
!define FLOATBOAT_WINDOW_HEIGHT 600
!define FLOATBOAT_PAGE_WIDTH 684
!define FLOATBOAT_PAGE_HEIGHT 510
!define FLOATBOAT_CANCEL_X 580
!define FLOATBOAT_CANCEL_Y 534
!define FLOATBOAT_SWP_NOZORDER_NOACTIVATE 0x0014
!define FLOATBOAT_SWP_NOACTIVATE 0x0010
!define FLOATBOAT_SW_HIDE 0
!define FLOATBOAT_SW_SHOW 5

!macro BootstrapHideControl ControlId
  GetDlgItem $0 $BootstrapPageDialogHandle ${ControlId}
  ${If} $0 != 0
    System::Call 'USER32::ShowWindow(p $0, i ${FLOATBOAT_SW_HIDE})'
  ${EndIf}
!macroend

!macro BootstrapHideParentControl ControlId
  GetDlgItem $0 $HWNDPARENT ${ControlId}
  ${If} $0 != 0
    System::Call 'USER32::ShowWindow(p $0, i ${FLOATBOAT_SW_HIDE})'
  ${EndIf}
!macroend

Function BootstrapFindInstFilesDialog
  FindWindow $BootstrapPageDialogHandle "#32770" "" $HWNDPARENT
  ${If} $BootstrapPageDialogHandle == 0
    StrCpy $BootstrapPageDialogHandle $HWNDPARENT
  ${EndIf}
FunctionEnd

Function BootstrapWaitForInstFilesDialog
  StrCpy $R8 0

  _bootstrapInstFilesDialogWaitLoop:
    Call BootstrapFindInstFilesDialog
    ${If} $BootstrapPageDialogHandle != 0
      Return
    ${EndIf}

    IntOp $R8 $R8 + 1
    ${If} $R8 < 20
      Sleep 50
      Goto _bootstrapInstFilesDialogWaitLoop
    ${EndIf}
FunctionEnd

Function BootstrapResizeAndCleanWindow
  System::Call 'USER32::GetSystemMetrics(i 0) i.r0'
  System::Call 'USER32::GetSystemMetrics(i 1) i.r1'
  IntOp $2 $0 - ${FLOATBOAT_WINDOW_WIDTH}
  IntOp $2 $2 / 2
  IntOp $3 $1 - ${FLOATBOAT_WINDOW_HEIGHT}
  IntOp $3 $3 / 2
  ${If} $2 < 0
    StrCpy $2 0
  ${EndIf}
  ${If} $3 < 0
    StrCpy $3 0
  ${EndIf}

  System::Call 'USER32::SetWindowPos(p $HWNDPARENT, p 0, i $2, i $3, i ${FLOATBOAT_WINDOW_WIDTH}, i ${FLOATBOAT_WINDOW_HEIGHT}, i ${FLOATBOAT_SWP_NOZORDER_NOACTIVATE})'
  ${If} $BootstrapPageDialogHandle != $HWNDPARENT
    System::Call 'USER32::SetWindowPos(p $BootstrapPageDialogHandle, p 0, i 0, i 0, i ${FLOATBOAT_PAGE_WIDTH}, i ${FLOATBOAT_PAGE_HEIGHT}, i ${FLOATBOAT_SWP_NOZORDER_NOACTIVATE})'
  ${EndIf}

  !insertmacro BootstrapHideParentControl 1
  !insertmacro BootstrapHideParentControl 3
  !insertmacro BootstrapHideParentControl 1028
  !insertmacro BootstrapHideParentControl 1037
  !insertmacro BootstrapHideParentControl 1038
  !insertmacro BootstrapHideParentControl 1039

  GetDlgItem $0 $HWNDPARENT 2
  ${If} $0 != 0
    System::Call 'USER32::SetWindowTextW(p $0, w "取消")'
    System::Call 'USER32::ShowWindow(p $0, i ${FLOATBOAT_SW_SHOW})'
    System::Call 'USER32::SetWindowPos(p $0, p 0, i ${FLOATBOAT_CANCEL_X}, i ${FLOATBOAT_CANCEL_Y}, i 84, i 28, i ${FLOATBOAT_SWP_NOACTIVATE})'
  ${EndIf}
FunctionEnd

Function BootstrapInstFilesShow
  InitPluginsDir
  File /oname=$PLUGINSDIR\bootstrap-carousel-1.bmp "bootstrap-carousel-1.bmp"
  File /oname=$PLUGINSDIR\bootstrap-carousel-2.bmp "bootstrap-carousel-2.bmp"
  File /oname=$PLUGINSDIR\bootstrap-carousel-3.bmp "bootstrap-carousel-3.bmp"

  Call BootstrapWaitForInstFilesDialog
  ${If} $BootstrapPageDialogHandle == 0
    Return
  ${EndIf}

  Call BootstrapResizeAndCleanWindow

  !insertmacro BootstrapHideControl 1004
  !insertmacro BootstrapHideControl 1006
  !insertmacro BootstrapHideControl 1016
  !insertmacro BootstrapHideControl 1027
  !insertmacro BootstrapHideControl 1037

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "Floatboat 安装助手", i ${FLOATBOAT_STATIC_CENTER_STYLE}, i 40, i 24, i 604, i 28, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapTitleHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "正在下载完整安装包，完成后会自动打开正式安装器", i ${FLOATBOAT_STATIC_CENTER_STYLE}, i 40, i 54, i 604, i 22, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapSubtitleHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "", i ${FLOATBOAT_STATIC_BITMAP_STYLE}, i 92, i 92, i 500, i 304, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapImageHandle $0
  ${If} $BootstrapImageHandle == 0
    Return
  ${EndIf}

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "$(TXT_PREPARING)", i ${FLOATBOAT_STATIC_TEXT_STYLE}, i 92, i 412, i 330, i 24, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapStatusHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "0.00%", i ${FLOATBOAT_STATIC_RIGHT_STYLE}, i 442, i 412, i 150, i 24, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapPercentHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "msctls_progress32", w "", i ${FLOATBOAT_PROGRESS_STYLE}, i 92, i 446, i 500, i 18, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $ProgressBarHandle $0
  ${If} $ProgressBarHandle != 0
    SendMessage $ProgressBarHandle ${PBM_SETRANGE32} 0 10000
    SendMessage $ProgressBarHandle ${PBM_SETPOS} 0 0
  ${EndIf}

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "0.00% | $(TXT_DOWNLOADING)", i ${FLOATBOAT_STATIC_TEXT_STYLE}, i 92, i 474, i 500, i 20, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapMetaHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "请保持网络连接，下载异常会自动重试。", i ${FLOATBOAT_STATIC_CENTER_STYLE}, i 92, i 498, i 500, i 18, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapHintHandle $0

  System::Call 'USER32::LoadImageW(p 0, w "$PLUGINSDIR\bootstrap-carousel-1.bmp", i ${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i ${FLOATBOAT_LR_BITMAP_FLAGS}) p.r0'
  StrCpy $ProductCarouselBitmap1 $0
  System::Call 'USER32::LoadImageW(p 0, w "$PLUGINSDIR\bootstrap-carousel-2.bmp", i ${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i ${FLOATBOAT_LR_BITMAP_FLAGS}) p.r0'
  StrCpy $ProductCarouselBitmap2 $0
  System::Call 'USER32::LoadImageW(p 0, w "$PLUGINSDIR\bootstrap-carousel-3.bmp", i ${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i ${FLOATBOAT_LR_BITMAP_FLAGS}) p.r0'
  StrCpy $ProductCarouselBitmap3 $0

  StrCpy $ProductCarouselFrame 1
  StrCpy $ProductCarouselTick 0
  ${If} $ProductCarouselBitmap1 != 0
    SendMessage $BootstrapImageHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap1
    System::Call 'USER32::InvalidateRect(p $BootstrapImageHandle, p 0, i 1)'
    System::Call 'USER32::UpdateWindow(p $BootstrapImageHandle)'
  ${EndIf}
FunctionEnd

Function BootstrapEnsureProgressHandle
  ${If} $ProgressBarHandle == ""
    Call BootstrapFindInstFilesDialog
    GetDlgItem $ProgressBarHandle $BootstrapPageDialogHandle 1004
  ${EndIf}
  ${If} $ProgressBarHandle == 0
    Call BootstrapFindInstFilesDialog
    GetDlgItem $ProgressBarHandle $BootstrapPageDialogHandle 1004
  ${EndIf}
FunctionEnd

Function BootstrapRenderCustomStatus
  ${If} $DownloadProgressText != ""
    System::Call 'USER32::SetWindowTextW(p $HWNDPARENT, w "Floatboat 安装 - $DownloadProgressText")'
  ${Else}
    System::Call 'USER32::SetWindowTextW(p $HWNDPARENT, w "Floatboat 安装")'
  ${EndIf}

  ${If} $BootstrapStatusHandle != ""
  ${AndIf} $BootstrapStatusHandle != 0
    System::Call 'USER32::SetWindowTextW(p $BootstrapStatusHandle, w "$DownloadStatusLine")'
  ${EndIf}

  ${If} $BootstrapMetaHandle != ""
  ${AndIf} $BootstrapMetaHandle != 0
    System::Call 'USER32::SetWindowTextW(p $BootstrapMetaHandle, w "$DownloadMetaLine")'
  ${EndIf}

  ${If} $BootstrapPercentHandle != ""
  ${AndIf} $BootstrapPercentHandle != 0
    System::Call 'USER32::SetWindowTextW(p $BootstrapPercentHandle, w "$DownloadProgressText")'
  ${EndIf}
FunctionEnd

Function BootstrapUpdateProductCarousel
  ${If} $BootstrapImageHandle == ""
    Return
  ${EndIf}
  ${If} $BootstrapImageHandle == 0
    Return
  ${EndIf}

  IntOp $ProductCarouselTick $ProductCarouselTick + 1
  ${If} $ProductCarouselTick < 66
    Return
  ${EndIf}

  StrCpy $ProductCarouselTick 0
  ${If} $ProductCarouselFrame == 1
    StrCpy $ProductCarouselFrame 2
    ${If} $ProductCarouselBitmap2 != 0
      SendMessage $BootstrapImageHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap2
      System::Call 'USER32::InvalidateRect(p $BootstrapImageHandle, p 0, i 1)'
      System::Call 'USER32::UpdateWindow(p $BootstrapImageHandle)'
    ${EndIf}
  ${ElseIf} $ProductCarouselFrame == 2
    StrCpy $ProductCarouselFrame 3
    ${If} $ProductCarouselBitmap3 != 0
      SendMessage $BootstrapImageHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap3
      System::Call 'USER32::InvalidateRect(p $BootstrapImageHandle, p 0, i 1)'
      System::Call 'USER32::UpdateWindow(p $BootstrapImageHandle)'
    ${EndIf}
  ${Else}
    StrCpy $ProductCarouselFrame 1
    ${If} $ProductCarouselBitmap1 != 0
      SendMessage $BootstrapImageHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap1
      System::Call 'USER32::InvalidateRect(p $BootstrapImageHandle, p 0, i 1)'
      System::Call 'USER32::UpdateWindow(p $BootstrapImageHandle)'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function BootstrapDestroyProductCarousel
  ${If} $BootstrapImageHandle != ""
  ${AndIf} $BootstrapImageHandle != 0
    System::Call 'USER32::DestroyWindow(p $BootstrapImageHandle)'
    StrCpy $BootstrapImageHandle ""
  ${EndIf}

  ${If} $BootstrapTitleHandle != ""
  ${AndIf} $BootstrapTitleHandle != 0
    System::Call 'USER32::DestroyWindow(p $BootstrapTitleHandle)'
    StrCpy $BootstrapTitleHandle ""
  ${EndIf}

  ${If} $BootstrapSubtitleHandle != ""
  ${AndIf} $BootstrapSubtitleHandle != 0
    System::Call 'USER32::DestroyWindow(p $BootstrapSubtitleHandle)'
    StrCpy $BootstrapSubtitleHandle ""
  ${EndIf}

  ${If} $BootstrapStatusHandle != ""
  ${AndIf} $BootstrapStatusHandle != 0
    System::Call 'USER32::DestroyWindow(p $BootstrapStatusHandle)'
    StrCpy $BootstrapStatusHandle ""
  ${EndIf}

  ${If} $BootstrapMetaHandle != ""
  ${AndIf} $BootstrapMetaHandle != 0
    System::Call 'USER32::DestroyWindow(p $BootstrapMetaHandle)'
    StrCpy $BootstrapMetaHandle ""
  ${EndIf}

  ${If} $BootstrapPercentHandle != ""
  ${AndIf} $BootstrapPercentHandle != 0
    System::Call 'USER32::DestroyWindow(p $BootstrapPercentHandle)'
    StrCpy $BootstrapPercentHandle ""
  ${EndIf}

  ${If} $BootstrapHintHandle != ""
  ${AndIf} $BootstrapHintHandle != 0
    System::Call 'USER32::DestroyWindow(p $BootstrapHintHandle)'
    StrCpy $BootstrapHintHandle ""
  ${EndIf}

  ${If} $ProductCarouselBitmap1 != ""
  ${AndIf} $ProductCarouselBitmap1 != 0
    System::Call 'GDI32::DeleteObject(p $ProductCarouselBitmap1)'
    StrCpy $ProductCarouselBitmap1 ""
  ${EndIf}

  ${If} $ProductCarouselBitmap2 != ""
  ${AndIf} $ProductCarouselBitmap2 != 0
    System::Call 'GDI32::DeleteObject(p $ProductCarouselBitmap2)'
    StrCpy $ProductCarouselBitmap2 ""
  ${EndIf}

  ${If} $ProductCarouselBitmap3 != ""
  ${AndIf} $ProductCarouselBitmap3 != 0
    System::Call 'GDI32::DeleteObject(p $ProductCarouselBitmap3)'
    StrCpy $ProductCarouselBitmap3 ""
  ${EndIf}
FunctionEnd
'@

  $source = $source.Replace(
    "Function BootstrapAbortCleanup",
    "$functionBlock${newline}Function BootstrapAbortCleanup"
  )
}

if (-not $source.Contains("Call BootstrapDestroyProductCarousel${newline}${newline}  `${If} `$DownloadPidFile")) {
  $source = $source.Replace(
    "Function BootstrapAbortCleanup${newline}  `${If} `$DownloadPidFile",
    "Function BootstrapAbortCleanup${newline}  Call BootstrapDestroyProductCarousel${newline}${newline}  `${If} `$DownloadPidFile"
  )
}

if ($source.Contains("GetDlgItem `$ProgressBarHandle `$HWNDPARENT 1004")) {
  $source = $source.Replace(
    "GetDlgItem `$ProgressBarHandle `$HWNDPARENT 1004",
    "Call BootstrapEnsureProgressHandle"
  )
}

if (-not $source.Contains('Call BootstrapRenderCustomStatus')) {
  $source = $source.Replace(
    "    StrCpy `$DownloadLastRenderedLine `$0${newline}  `${EndIf}${newline}!macroend",
    "    StrCpy `$DownloadLastRenderedLine `$0${newline}  `${EndIf}${newline}  Call BootstrapRenderCustomStatus${newline}!macroend"
  )
}

if (-not $source.Contains("DownloadPoll:${newline}  Call BootstrapUpdateProductCarousel")) {
  $source = $source.Replace(
    "DownloadPoll:${newline}  !insertmacro RefreshDownloadUi",
    "DownloadPoll:${newline}  Call BootstrapUpdateProductCarousel${newline}  !insertmacro RefreshDownloadUi"
  )
}

if (-not $source.Contains("StrCpy `$DownloadStateStableTicks 0")) {
  $source = $source.Replace(
    "  StrCpy `$DownloadPollEmptyTicks 0${newline}  DetailPrint `"`$(TXT_PREPARING)`"",
    "  StrCpy `$DownloadPollEmptyTicks 0${newline}  StrCpy `$DownloadLastProgressValue -1${newline}  StrCpy `$DownloadLastStateValue `"`"${newline}  StrCpy `$DownloadStateStableTicks 0${newline}  DetailPrint `"`$(TXT_PREPARING)`""
  )
  if (-not $source.Contains("StrCpy `$DownloadStateStableTicks 0")) {
    throw "Unable to patch download stale-state counters in $nsiPath"
  }
}

if (-not $source.Contains("DownloadStateStableTicks > 3000")) {
  $oldDownloadPollBlock = Convert-Newlines -Newline $newline -Content @'
  ${If} $0 == "ERROR:"
    StrCpy $DownloadResult $DownloadResult "" 6
    Goto DownloadFailed
  ${EndIf}

  ${If} $DownloadResult == ""
'@

  $newDownloadPollBlock = Convert-Newlines -Newline $newline -Content @'
  ${If} $0 == "ERROR:"
    StrCpy $DownloadResult $DownloadResult "" 6
    Goto DownloadFailed
  ${EndIf}

  ${If} $DownloadProgressValue == $DownloadLastProgressValue
  ${AndIf} $DownloadResult == $DownloadLastStateValue
    IntOp $DownloadStateStableTicks $DownloadStateStableTicks + 1
    ${If} $DownloadStateStableTicks > 3000
      StrCpy $DownloadResult "下载器状态长时间没有更新，请检查网络连接或代理设置。"
      Goto DownloadFailed
    ${EndIf}
  ${Else}
    StrCpy $DownloadLastProgressValue $DownloadProgressValue
    StrCpy $DownloadLastStateValue $DownloadResult
    StrCpy $DownloadStateStableTicks 0
  ${EndIf}

  ${If} $DownloadResult == ""
'@

  if (-not $source.Contains($oldDownloadPollBlock)) {
    throw "Unable to patch download stale-state guard in $nsiPath"
  }

  $source = $source.Replace($oldDownloadPollBlock, $newDownloadPollBlock)
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
  'BrandingText " "',
  '!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow',
  'LangString TXT_READY_TO_LAUNCH',
  'Var BootstrapPageDialogHandle',
  'Var DownloadStateStableTicks',
  'Var BootstrapSubtitleHandle',
  '!define FLOATBOAT_LR_BITMAP_FLAGS',
  'Function BootstrapInstFilesShow',
  'Function BootstrapResizeAndCleanWindow',
  'BootstrapHideParentControl',
  'Call BootstrapEnsureProgressHandle',
  'Call BootstrapRenderCustomStatus',
  'Call BootstrapUpdateProductCarousel',
  'InvalidateRect',
  'DownloadStateStableTicks > 3000',
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

$downloadSource = Read-TextFile -Path $downloadScriptPath
$downloadSource = $downloadSource.Replace('$UnknownSizeStepPercent = 0.41', '$UnknownSizeStepPercent = 0.08')
if (-not $downloadSource.Contains('$curlExe = Join-Path $env:SystemRoot')) {
  $downloadNewline = if ($downloadSource.Contains("`r`n")) { "`r`n" } else { "`n" }
  $newDownloadBlock = Convert-Newlines -Newline $downloadNewline -Content @'
  $outDir = Split-Path -Parent $OutFile
  if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  }

  function Join-ProcessArguments([string[]]$Arguments) {
    $quoted = @()
    foreach ($argument in $Arguments) {
      $value = [string]$argument
      if ($value.Length -eq 0 -or $value -match '[\s"]') {
        $value = '"' + ($value -replace '"', '\"') + '"'
      }

      $quoted += $value
    }

    return ($quoted -join ' ')
  }

  function Get-CurlPath() {
    $curlExe = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curlExe) {
      return $curlExe
    }

    $curlCommand = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -ne $curlCommand) {
      return $curlCommand.Source
    }

    return ''
  }

  function Reset-DownloadProgressVariables(
    [string]$StatusLine,
    [string]$MetaLine
  ) {
    $script:totalBytes = 0.0
    $script:downloadedBytes = 0.0
    $script:actualPercent = 0.0
    $script:displayPercent = 0.0
    $script:unknownSizePercent = 0.0
    $script:smoothedSpeedBytesPerSecond = 0.0
    $script:lastSpeedSampleBytes = 0.0
    $script:lastSpeedSampleAtMs = 0.0
    $script:lastProgressWriteAtMs = -1.0
    $script:stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $script:lastNetworkActivityAtMs = 0.0

    Write-ProgressSnapshot `
      -DisplayPercent 0.0 `
      -StatusLine $StatusLine `
      -MetaLine $MetaLine `
      -State 'STARTING'
  }

  function Assert-DownloadedInstaller([string]$PartialFile) {
    if (Test-Path -LiteralPath $PartialFile) {
      $script:downloadedBytes = [double](Get-Item -LiteralPath $PartialFile).Length
    }

    if ($script:downloadedBytes -le 0) {
      throw (Get-Text -English 'The installer download completed without data.' -Chinese '安装包下载完成但文件为空。')
    }

    Move-Item -LiteralPath $PartialFile -Destination $OutFile -Force
  }

  function Invoke-CurlDownload(
    [string]$DownloadUrl,
    [int]$SourceIndex,
    [int]$SourceCount
  ) {
    $curlExe = Get-CurlPath
    if ([string]::IsNullOrWhiteSpace($curlExe)) {
      throw (Get-Text -English 'Windows curl.exe is not available on this system.' -Chinese '当前系统找不到 Windows curl.exe。')
    }

    $partialFile = "$OutFile.download"
    Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue

    Reset-DownloadProgressVariables `
      -StatusLine (Get-Text -English "Connecting to Floatboat download source $SourceIndex of $SourceCount" -Chinese "正在连接 Floatboat 下载源 $SourceIndex/$SourceCount") `
      -MetaLine (Get-Text -English '0.00% | Windows curl download' -Chinese '0.00% | 正在通过 Windows curl 下载')

    $curlArguments = @(
      '--location',
      '--fail',
      '--silent',
      '--show-error',
      '--http1.1',
      '--ssl-no-revoke',
      '--connect-timeout', '20',
      '--speed-time', '30',
      '--speed-limit', '1024',
      '--retry', '2',
      '--retry-delay', '1',
      '--output', $partialFile,
      $DownloadUrl
    )

    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $curlExe
    $processInfo.Arguments = Join-ProcessArguments -Arguments $curlArguments
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardError = $true

    $curlProcess = [System.Diagnostics.Process]::Start($processInfo)
    if ($null -eq $curlProcess) {
      throw (Get-Text -English 'Unable to start Windows curl.exe for the installer download.' -Chinese '无法启动 Windows curl.exe 下载安装包。')
    }

    while (-not $curlProcess.HasExited) {
      if (Test-Path -LiteralPath $partialFile) {
        $currentBytes = [double](Get-Item -LiteralPath $partialFile).Length
        if ($currentBytes -gt $script:downloadedBytes) {
          $script:downloadedBytes = $currentBytes
          $script:lastNetworkActivityAtMs = [double]$script:stopwatch.ElapsedMilliseconds
        }
      }

      Update-DownloadProgressFrame -ForceWrite $true

      if (($script:stopwatch.ElapsedMilliseconds - $script:lastNetworkActivityAtMs) -ge $StallTimeoutMs) {
        try {
          $curlProcess.Kill()
        } catch {
        }

        throw (Get-Text -English 'The installer download did not receive data in time.' -Chinese '安装包下载长时间没有收到数据。')
      }

      Start-Sleep -Milliseconds $ProgressWriteIntervalMs
    }

    $curlError = $curlProcess.StandardError.ReadToEnd()
    if ($curlProcess.ExitCode -ne 0) {
      $curlError = ($curlError -replace '\r', ' ' -replace '\n', ' ').Trim()
      if ([string]::IsNullOrWhiteSpace($curlError)) {
        $curlError = "curl.exe exit code $($curlProcess.ExitCode)"
      }

      throw (Get-Text -English "The installer download failed: $curlError" -Chinese "安装包下载失败：$curlError")
    }

    Assert-DownloadedInstaller -PartialFile $partialFile
  }

  function Invoke-BitsDownload(
    [string]$DownloadUrl,
    [int]$SourceIndex,
    [int]$SourceCount
  ) {
    Import-Module BitsTransfer -ErrorAction Stop

    $partialFile = "$OutFile.download"
    Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue

    Reset-DownloadProgressVariables `
      -StatusLine (Get-Text -English "Connecting through Windows background transfer $SourceIndex of $SourceCount" -Chinese "正在通过 Windows 后台传输连接下载源 $SourceIndex/$SourceCount") `
      -MetaLine (Get-Text -English '0.00% | Windows BITS download' -Chinese '0.00% | 正在通过 Windows BITS 下载')

    $bitsJob = $null
    $bitsCompleted = $false
    $lastBitsBytes = 0.0
    $bitsStallTimeoutMs = [Math]::Max(90000, ($StallTimeoutMs * 3))

    try {
      $bitsJob = Start-BitsTransfer `
        -Source $DownloadUrl `
        -Destination $partialFile `
        -DisplayName 'Floatboat installer download' `
        -Description 'Floatboat setup package' `
        -Asynchronous `
        -TransferType Download `
        -ErrorAction Stop

      $bitsJobId = $bitsJob.JobId
      while ($true) {
        $currentJob = Get-BitsTransfer -ErrorAction Stop | Where-Object { $_.JobId -eq $bitsJobId } | Select-Object -First 1
        if ($null -eq $currentJob) {
          throw (Get-Text -English 'Windows background transfer job disappeared.' -Chinese 'Windows 后台传输任务已消失。')
        }

        $currentBytes = [double]$currentJob.BytesTransferred
        if ($currentBytes -gt $script:downloadedBytes) {
          $script:downloadedBytes = $currentBytes
          $script:lastNetworkActivityAtMs = [double]$script:stopwatch.ElapsedMilliseconds
          $lastBitsBytes = $currentBytes
        }

        if ($currentJob.BytesTotal -gt 0 -and $currentJob.BytesTotal -lt [UInt64]::MaxValue) {
          $script:totalBytes = [double]$currentJob.BytesTotal
        }

        Update-DownloadProgressFrame -ForceWrite $true

        $stateName = [string]$currentJob.JobState
        if ($stateName -eq 'Transferred') {
          Complete-BitsTransfer -BitsJob $currentJob -ErrorAction Stop
          $bitsCompleted = $true
          break
        }

        if ($stateName -eq 'Error' -or $stateName -eq 'TransientError') {
          $bitsError = [string]$currentJob.ErrorDescription
          if ([string]::IsNullOrWhiteSpace($bitsError)) {
            $bitsError = "BITS job state $stateName"
          }

          if ($stateName -eq 'TransientError' -and (($script:stopwatch.ElapsedMilliseconds - $script:lastNetworkActivityAtMs) -lt $bitsStallTimeoutMs)) {
            Start-Sleep -Milliseconds $ProgressWriteIntervalMs
            continue
          }

          throw (Get-Text -English "Windows background transfer failed: $bitsError" -Chinese "Windows 后台传输失败：$bitsError")
        }

        if ($stateName -eq 'Suspended') {
          Resume-BitsTransfer -BitsJob $currentJob -Asynchronous -ErrorAction SilentlyContinue | Out-Null
        }

        if (($script:stopwatch.ElapsedMilliseconds - $script:lastNetworkActivityAtMs) -ge $bitsStallTimeoutMs) {
          throw (Get-Text -English 'Windows background transfer did not receive data in time.' -Chinese 'Windows 后台传输长时间没有收到数据。')
        }

        Start-Sleep -Milliseconds $ProgressWriteIntervalMs
      }
    } finally {
      if (-not $bitsCompleted -and $null -ne $bitsJob) {
        Remove-BitsTransfer -BitsJob $bitsJob -Confirm:$false -ErrorAction SilentlyContinue
      }
    }

    if ($lastBitsBytes -gt 0) {
      $script:downloadedBytes = $lastBitsBytes
    }
    Assert-DownloadedInstaller -PartialFile $partialFile
  }

  function Invoke-DotNetDownload(
    [string]$DownloadUrl,
    [int]$SourceIndex,
    [int]$SourceCount
  ) {
    $partialFile = "$OutFile.download"
    Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue

    Reset-DownloadProgressVariables `
      -StatusLine (Get-Text -English "Trying backup download source $SourceIndex of $SourceCount" -Chinese "正在尝试备用下载源 $SourceIndex/$SourceCount") `
      -MetaLine (Get-Text -English '0.00% | PowerShell backup download' -Chinese '0.00% | 正在通过 PowerShell 备用下载')

    $request = [System.Net.HttpWebRequest]::Create($DownloadUrl)
    $request.Method = 'GET'
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 30000
    $response = $request.GetResponse()

    try {
      $script:totalBytes = [double]$response.ContentLength
      $inputStream = $response.GetResponseStream()
      $outputStream = [System.IO.File]::Open($partialFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $buffer = New-Object byte[] 65536

      try {
        Update-DownloadProgressFrame -ForceWrite $true

        while ($true) {
          $readAsyncResult = $inputStream.BeginRead($buffer, 0, $buffer.Length, $null, $null)
          try {
            while (-not $readAsyncResult.AsyncWaitHandle.WaitOne($ProgressWriteIntervalMs)) {
              Update-DownloadProgressFrame

              if (($script:stopwatch.ElapsedMilliseconds - $script:lastNetworkActivityAtMs) -ge $StallTimeoutMs) {
                throw (Get-Text -English 'The installer download stalled for too long.' -Chinese '安装包下载长时间没有响应。')
              }
            }

            $read = $inputStream.EndRead($readAsyncResult)
          } finally {
            if ($readAsyncResult.AsyncWaitHandle) {
              $readAsyncResult.AsyncWaitHandle.Close()
            }
          }

          if ($read -le 0) {
            break
          }

          $outputStream.Write($buffer, 0, $read)
          $script:downloadedBytes += $read
          $script:lastNetworkActivityAtMs = [double]$script:stopwatch.ElapsedMilliseconds
          Update-DownloadProgressFrame -ForceWrite $true
        }
      } finally {
        if ($outputStream) {
          $outputStream.Close()
        }
        if ($inputStream) {
          $inputStream.Close()
        }
      }
    } finally {
      $response.Close()
    }

    Assert-DownloadedInstaller -PartialFile $partialFile
  }

  $downloadUrls = @()
  foreach ($candidate in ($Url -split '\|')) {
    $trimmedCandidate = ([string]$candidate).Trim()
    if (-not [string]::IsNullOrWhiteSpace($trimmedCandidate)) {
      $downloadUrls += $trimmedCandidate
    }
  }

  if ($downloadUrls.Count -eq 0) {
    throw (Get-Text -English 'No installer download URL is configured.' -Chinese '没有配置安装包下载地址。')
  }

  $downloadErrors = @()
  $downloadCompleted = $false
  for ($sourceIndex = 0; $sourceIndex -lt $downloadUrls.Count; $sourceIndex += 1) {
    $sourceNumber = $sourceIndex + 1
    $candidateUrl = $downloadUrls[$sourceIndex]

    try {
      Invoke-BitsDownload -DownloadUrl $candidateUrl -SourceIndex $sourceNumber -SourceCount $downloadUrls.Count
      $downloadCompleted = $true
      break
    } catch {
      $downloadErrors += ('source {0} bits: {1}' -f $sourceNumber, (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
    }

    try {
      Invoke-CurlDownload -DownloadUrl $candidateUrl -SourceIndex $sourceNumber -SourceCount $downloadUrls.Count
      $downloadCompleted = $true
      break
    } catch {
      $downloadErrors += ('source {0} curl: {1}' -f $sourceNumber, (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
    }

    try {
      Invoke-DotNetDownload -DownloadUrl $candidateUrl -SourceIndex $sourceNumber -SourceCount $downloadUrls.Count
      $downloadCompleted = $true
      break
    } catch {
      $downloadErrors += ('source {0} powershell: {1}' -f $sourceNumber, (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
    }

    if ($sourceNumber -lt $downloadUrls.Count) {
      Write-ProgressSnapshot `
        -DisplayPercent 0.0 `
        -StatusLine (Get-Text -English 'Switching to the next Floatboat download source' -Chinese '正在切换到下一个 Floatboat 下载源') `
        -MetaLine (Get-Text -English '0.00% | Retrying with backup source' -Chinese '0.00% | 正在使用备用源重试') `
        -State 'STARTING'
      Start-Sleep -Milliseconds 800
    }
  }

  if (-not $downloadCompleted) {
    $joinedErrors = ($downloadErrors -join '; ')
    throw (Get-Text -English "All installer download sources failed: $joinedErrors" -Chinese "所有安装包下载源都失败：$joinedErrors")
  }
'@

  $downloadPattern = '(?s)  \$request = \[System\.Net\.HttpWebRequest\]::Create\(\$Url\).*?  \$response\.Close\(\)\r?\n'
  if (-not [regex]::IsMatch($downloadSource, $downloadPattern)) {
    throw "Unable to patch curl downloader in $downloadScriptPath"
  }

  $downloadSource = [regex]::Replace(
    $downloadSource,
    $downloadPattern,
    [System.Text.RegularExpressions.MatchEvaluator] { param($match) $newDownloadBlock },
    1
  )
  Write-Utf8BomFile -Path $downloadScriptPath -Content $downloadSource
}

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
Write-Host "  carousel images:  bootstrap-carousel-1.bmp, bootstrap-carousel-2.bmp, bootstrap-carousel-3.bmp"
Write-Host "  custom page:      enlarged window with hidden default header/details"
Write-Host "  downloader:       Windows BITS with curl/PowerShell fallback and backup URLs"
Write-Host "  launch delay:     ${LaunchDelayMs}ms"
