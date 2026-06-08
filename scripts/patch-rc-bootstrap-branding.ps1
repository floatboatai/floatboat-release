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

if (-not $source.Contains("Var ProductCarouselDialogHandle")) {
  $source = $source.Replace(
    "Var DownloadPollEmptyTicks",
    "Var DownloadPollEmptyTicks${newline}Var ProductCarouselDialogHandle${newline}Var ProductCarouselHandle${newline}Var ProductCarouselBitmap1${newline}Var ProductCarouselBitmap2${newline}Var ProductCarouselBitmap3${newline}Var ProductCarouselFrame${newline}Var ProductCarouselTick"
  )
}

if (-not $source.Contains("Function BootstrapInstFilesShow")) {
  $functionBlock = Convert-Newlines -Newline $newline -Content @'

!define FLOATBOAT_PRODUCT_PANEL_STYLE 0x5000000E
!define FLOATBOAT_IMAGE_BITMAP 0
!define FLOATBOAT_LR_LOADFROMFILE 0x00000010
!define FLOATBOAT_STM_SETIMAGE 0x0172

Function BootstrapFindInstFilesControls
  FindWindow $ProductCarouselDialogHandle "#32770" "" $HWNDPARENT
  ${If} $ProductCarouselDialogHandle != 0
    GetDlgItem $ProgressBarHandle $ProductCarouselDialogHandle 1004
  ${EndIf}
FunctionEnd

Function BootstrapWaitForInstFilesControls
  StrCpy $R8 0

  _bootstrapInstFilesControlWaitLoop:
    Call BootstrapFindInstFilesControls
    ${If} $ProductCarouselDialogHandle != 0
    ${AndIf} $ProgressBarHandle != 0
      Return
    ${EndIf}

    IntOp $R8 $R8 + 1
    ${If} $R8 < 20
      Sleep 50
      Goto _bootstrapInstFilesControlWaitLoop
    ${EndIf}
FunctionEnd

Function BootstrapInstFilesShow
  InitPluginsDir
  File /oname=$PLUGINSDIR\bootstrap-carousel-1.bmp "bootstrap-carousel-1.bmp"
  File /oname=$PLUGINSDIR\bootstrap-carousel-2.bmp "bootstrap-carousel-2.bmp"
  File /oname=$PLUGINSDIR\bootstrap-carousel-3.bmp "bootstrap-carousel-3.bmp"

  Call BootstrapWaitForInstFilesControls
  ${If} $ProductCarouselDialogHandle == 0
    Return
  ${EndIf}

  System::Call 'USER32::CreateWindowExW(i 0, w "STATIC", w "", i ${FLOATBOAT_PRODUCT_PANEL_STYLE}, i 18, i 112, i 438, i 160, p $ProductCarouselDialogHandle, p 0, p 0, p 0) p.r0'
  StrCpy $ProductCarouselHandle $0
  ${If} $ProductCarouselHandle == 0
    Return
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
    SendMessage $ProductCarouselHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap1
  ${EndIf}
FunctionEnd

Function BootstrapUpdateProductCarousel
  ${If} $ProductCarouselHandle == ""
    Return
  ${EndIf}
  ${If} $ProductCarouselHandle == 0
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
      SendMessage $ProductCarouselHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap2
    ${EndIf}
  ${ElseIf} $ProductCarouselFrame == 2
    StrCpy $ProductCarouselFrame 3
    ${If} $ProductCarouselBitmap3 != 0
      SendMessage $ProductCarouselHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap3
    ${EndIf}
  ${Else}
    StrCpy $ProductCarouselFrame 1
    ${If} $ProductCarouselBitmap1 != 0
      SendMessage $ProductCarouselHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap1
    ${EndIf}
  ${EndIf}
FunctionEnd

Function BootstrapDestroyProductCarousel
  ${If} $ProductCarouselHandle != ""
  ${AndIf} $ProductCarouselHandle != 0
    System::Call 'USER32::DestroyWindow(p $ProductCarouselHandle)'
    StrCpy $ProductCarouselHandle ""
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
    "Call BootstrapFindInstFilesControls"
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
  'Function BootstrapInstFilesShow',
  'Call BootstrapFindInstFilesControls',
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
if (-not $downloadSource.Contains('$responseAsyncResult = $request.BeginGetResponse($null, $null)')) {
  $downloadNewline = if ($downloadSource.Contains("`r`n")) { "`r`n" } else { "`n" }
  $oldConnectBlock = Convert-Newlines -Newline $downloadNewline -Content @'
  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.Method = 'GET'
  $request.Timeout = 30000
  $request.ReadWriteTimeout = 30000
  $response = $request.GetResponse()
  $totalBytes = [double]$response.ContentLength
  $inputStream = $response.GetResponseStream()
'@

  $newConnectBlock = Convert-Newlines -Newline $downloadNewline -Content @'
  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.Method = 'GET'
  $request.Timeout = $StallTimeoutMs
  $request.ReadWriteTimeout = $StallTimeoutMs
  $request.AllowAutoRedirect = $true
  $request.UserAgent = 'FloatboatBootstrapInstaller/1.0'
  $request.KeepAlive = $false

  $response = $null
  $connectStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $connectDisplayPercent = 0.0
  $responseAsyncResult = $request.BeginGetResponse($null, $null)
  try {
    while (-not $responseAsyncResult.AsyncWaitHandle.WaitOne($ProgressWriteIntervalMs)) {
      $elapsedMs = [double]$connectStopwatch.ElapsedMilliseconds
      if ($elapsedMs -ge $StallTimeoutMs) {
        $request.Abort()
        throw (Get-Text -English 'The installer download could not connect to the server in time. Please check your network and try again.' -Chinese '安装包下载连接服务器超时，请检查网络后重试。')
      }

      $connectDisplayPercent = [Math]::Min(8.0, $connectDisplayPercent + 0.04)
      $elapsedSeconds = [Math]::Max(1.0, $elapsedMs / 1000.0)
      Write-ProgressSnapshot `
        -DisplayPercent $connectDisplayPercent `
        -StatusLine (Get-Text -English 'Connecting to the Floatboat download server' -Chinese '正在连接 Floatboat 下载服务器') `
        -MetaLine (Get-Text -English ([string]::Format($InvariantCulture, '{0:F2}% | Connecting for {1:F0}s', $connectDisplayPercent, $elapsedSeconds)) -Chinese ([string]::Format($InvariantCulture, '{0:F2}% | 已连接 {1:F0} 秒', $connectDisplayPercent, $elapsedSeconds))) `
        -State 'CONNECTING'
    }

    $response = [System.Net.HttpWebResponse]$request.EndGetResponse($responseAsyncResult)
  } finally {
    if ($responseAsyncResult.AsyncWaitHandle) {
      $responseAsyncResult.AsyncWaitHandle.Close()
    }
  }

  $totalBytes = [double]$response.ContentLength
  $inputStream = $response.GetResponseStream()
'@

  if (-not $downloadSource.Contains($oldConnectBlock)) {
    throw "Unable to patch connection watchdog in $downloadScriptPath"
  }

  $downloadSource = $downloadSource.Replace($oldConnectBlock, $newConnectBlock)
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
Write-Host "  connection guard: enabled"
Write-Host "  launch delay:     ${LaunchDelayMs}ms"
