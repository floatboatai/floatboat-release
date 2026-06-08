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

if (-not $source.Contains("Var BootstrapPageDialogHandle")) {
  $source = $source.Replace(
    "Var DownloadPollEmptyTicks",
    "Var DownloadPollEmptyTicks${newline}Var BootstrapPageDialogHandle${newline}Var BootstrapImageHandle${newline}Var BootstrapTitleHandle${newline}Var BootstrapStatusHandle${newline}Var BootstrapMetaHandle${newline}Var BootstrapPercentHandle${newline}Var ProductCarouselBitmap1${newline}Var ProductCarouselBitmap2${newline}Var ProductCarouselBitmap3${newline}Var ProductCarouselFrame${newline}Var ProductCarouselTick"
  )
}

if (-not $source.Contains("Function BootstrapInstFilesShow")) {
  $functionBlock = Convert-Newlines -Newline $newline -Content @'

!define FLOATBOAT_CHILD_VISIBLE 0x50000000
!define FLOATBOAT_STATIC_BITMAP_STYLE 0x5000000E
!define FLOATBOAT_STATIC_TEXT_STYLE 0x50000000
!define FLOATBOAT_PROGRESS_STYLE 0x50000000
!define FLOATBOAT_IMAGE_BITMAP 0
!define FLOATBOAT_LR_LOADFROMFILE 0x00000010
!define FLOATBOAT_STM_SETIMAGE 0x0172
!define FLOATBOAT_SW_HIDE 0

!macro BootstrapHideControl ControlId
  GetDlgItem $0 $BootstrapPageDialogHandle ${ControlId}
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

Function BootstrapInstFilesShow
  InitPluginsDir
  File /oname=$PLUGINSDIR\bootstrap-carousel-1.bmp "bootstrap-carousel-1.bmp"
  File /oname=$PLUGINSDIR\bootstrap-carousel-2.bmp "bootstrap-carousel-2.bmp"
  File /oname=$PLUGINSDIR\bootstrap-carousel-3.bmp "bootstrap-carousel-3.bmp"

  Call BootstrapWaitForInstFilesDialog
  ${If} $BootstrapPageDialogHandle == 0
    Return
  ${EndIf}

  !insertmacro BootstrapHideControl 1004
  !insertmacro BootstrapHideControl 1006
  !insertmacro BootstrapHideControl 1016
  !insertmacro BootstrapHideControl 1027
  !insertmacro BootstrapHideControl 1037

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "Floatboat", i ${FLOATBOAT_STATIC_TEXT_STYLE}, i 18, i 14, i 438, i 22, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapTitleHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "", i ${FLOATBOAT_STATIC_BITMAP_STYLE}, i 18, i 44, i 438, i 160, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapImageHandle $0
  ${If} $BootstrapImageHandle == 0
    Return
  ${EndIf}

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "$(TXT_PREPARING)", i ${FLOATBOAT_STATIC_TEXT_STYLE}, i 18, i 218, i 438, i 22, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapStatusHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "0.00% | $(TXT_DOWNLOADING)", i ${FLOATBOAT_STATIC_TEXT_STYLE}, i 18, i 242, i 344, i 18, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapMetaHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "0.00%", i ${FLOATBOAT_STATIC_TEXT_STYLE}, i 366, i 242, i 90, i 18, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $BootstrapPercentHandle $0

  System::Call 'USER32::CreateWindowExW(i 0, w "msctls_progress32", w "", i ${FLOATBOAT_PROGRESS_STYLE}, i 18, i 266, i 438, i 14, p $BootstrapPageDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $ProgressBarHandle $0
  ${If} $ProgressBarHandle != 0
    SendMessage $ProgressBarHandle ${PBM_SETRANGE32} 0 10000
    SendMessage $ProgressBarHandle ${PBM_SETPOS} 0 0
  ${EndIf}

  System::Call 'USER32::LoadImageW(p 0, w "$PLUGINSDIR\bootstrap-carousel-1.bmp", i ${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i ${FLOATBOAT_LR_LOADFROMFILE}) p.r0'
  StrCpy $ProductCarouselBitmap1 $0
  System::Call 'USER32::LoadImageW(p 0, w "$PLUGINSDIR\bootstrap-carousel-2.bmp", i ${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i ${FLOATBOAT_LR_LOADFROMFILE}) p.r0'
  StrCpy $ProductCarouselBitmap2 $0
  System::Call 'USER32::LoadImageW(p 0, w "$PLUGINSDIR\bootstrap-carousel-3.bmp", i ${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i ${FLOATBOAT_LR_LOADFROMFILE}) p.r0'
  StrCpy $ProductCarouselBitmap3 $0

  StrCpy $ProductCarouselFrame 1
  StrCpy $ProductCarouselTick 0
  ${If} $ProductCarouselBitmap1 != 0
    SendMessage $BootstrapImageHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap1
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
    ${EndIf}
  ${ElseIf} $ProductCarouselFrame == 2
    StrCpy $ProductCarouselFrame 3
    ${If} $ProductCarouselBitmap3 != 0
      SendMessage $BootstrapImageHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap3
    ${EndIf}
  ${Else}
    StrCpy $ProductCarouselFrame 1
    ${If} $ProductCarouselBitmap1 != 0
      SendMessage $BootstrapImageHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap1
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
  '!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow',
  'LangString TXT_READY_TO_LAUNCH',
  'Var BootstrapPageDialogHandle',
  'Function BootstrapInstFilesShow',
  'Call BootstrapEnsureProgressHandle',
  'Call BootstrapRenderCustomStatus',
  'Call BootstrapUpdateProductCarousel',
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

  $curlExe = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (-not (Test-Path -LiteralPath $curlExe)) {
    $curlCommand = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -eq $curlCommand) {
      throw (Get-Text -English 'Windows curl.exe is not available on this system.' -Chinese '当前系统找不到 Windows curl.exe。')
    }

    $curlExe = $curlCommand.Source
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

  $partialFile = "$OutFile.download"
  Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue

  $totalBytes = 0.0
  $downloadedBytes = 0.0
  $actualPercent = 0.0
  $displayPercent = 0.0
  $unknownSizePercent = 0.0
  $smoothedSpeedBytesPerSecond = 0.0
  $lastSpeedSampleBytes = 0.0
  $lastSpeedSampleAtMs = 0.0
  $lastProgressWriteAtMs = -1.0
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $lastNetworkActivityAtMs = 0.0

  Write-ProgressSnapshot `
    -DisplayPercent 0.0 `
    -StatusLine (Get-Text -English 'Starting the Floatboat installer download' -Chinese '正在启动 Floatboat 安装包下载') `
    -MetaLine (Get-Text -English '0.00% | Connecting through Windows curl' -Chinese '0.00% | 正在通过 Windows curl 建立连接') `
    -State 'STARTING'

  $curlArguments = @(
    '--location',
    '--fail',
    '--silent',
    '--show-error',
    '--connect-timeout', '20',
    '--speed-time', '30',
    '--speed-limit', '1024',
    '--retry', '2',
    '--retry-delay', '1',
    '--output', $partialFile,
    $Url
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
      if ($currentBytes -gt $downloadedBytes) {
        $downloadedBytes = $currentBytes
        $lastNetworkActivityAtMs = [double]$stopwatch.ElapsedMilliseconds
      }
    }

    Update-DownloadProgressFrame -ForceWrite $true

    if (($stopwatch.ElapsedMilliseconds - $lastNetworkActivityAtMs) -ge $StallTimeoutMs) {
      try {
        $curlProcess.Kill()
      } catch {
      }

      throw (Get-Text -English 'The installer download did not receive data in time. Please check your network and try again.' -Chinese '安装包下载长时间没有收到数据，请检查网络后重试。')
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

  if (Test-Path -LiteralPath $partialFile) {
    $downloadedBytes = [double](Get-Item -LiteralPath $partialFile).Length
  }

  if ($downloadedBytes -le 0) {
    throw (Get-Text -English 'The installer download completed without data.' -Chinese '安装包下载完成但文件为空。')
  }

  Move-Item -LiteralPath $partialFile -Destination $OutFile -Force
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
Write-Host "  custom page:      enabled"
Write-Host "  downloader:       Windows curl.exe with active file-size polling"
Write-Host "  launch delay:     ${LaunchDelayMs}ms"
