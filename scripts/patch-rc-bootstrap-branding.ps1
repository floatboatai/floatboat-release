param(
  [string]$InstallerDir = "floatboat-installer\win",
  [string]$AssetsDir = ".floatboat-release\installer-assets\windows\bootstrap",
  [int]$MaxCarouselFrames = 24,
  [string]$RemoteCarouselZipUrl = "https://release.aoe.chat/rc/Floatboat-Installer-RC-carousel.zip",
  [int]$LaunchDelayMs = 1500
)

$ErrorActionPreference = "Stop"

$nsiPath = Join-Path $InstallerDir "bootstrap-installer.nsi"
$downloadScriptPath = Join-Path $InstallerDir "download-installer.ps1"
$launchHiddenScriptPath = Join-Path $InstallerDir "launch-hidden.vbs"
$bootstrapCarouselScriptPath = Join-Path $InstallerDir "bootstrap-carousel.ps1"
$setupProgressScriptPath = "build\setup-progress-monitor.ps1"
$welcomeAssetPath = Join-Path $AssetsDir "welcome-product.bmp"
$targetWelcomeAssetPath = Join-Path $InstallerDir "bootstrap-welcome-product.bmp"
$carouselStaticAssets = @(
  @{ Key = "work"; Candidates = @("carousel-work.png", "carousel-work.jpg", "carousel-work.jpeg", "carousel-work.bmp") },
  @{ Key = "combo"; Candidates = @("carousel-combo.png", "carousel-combo.jpg", "carousel-combo.jpeg", "carousel-combo.bmp") },
  @{ Key = "tacit"; Candidates = @("carousel-tacit.png", "carousel-tacit.jpg", "carousel-tacit.jpeg", "carousel-tacit.bmp") }
)
$carouselGifPath = Join-Path $AssetsDir "carousel.gif"
$carouselFramesDir = Join-Path $AssetsDir "carousel-frames"
$carouselFrameWidth = 500
$carouselFrameHeight = 304
$utf8Bom = New-Object System.Text.UTF8Encoding -ArgumentList $true
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
$drawingLoaded = $false

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

function Escape-NsisQuotedValue([string]$Value) {
  $result = ([string]$Value).Replace('$', '$$')
  $result = $result.Replace('"', '$\"')
  return $result
}

function Ensure-DrawingLoaded() {
  if ($script:drawingLoaded) {
    return
  }

  Add-Type -AssemblyName System.Drawing
  $script:drawingLoaded = $true
}

function Get-BootstrapCarouselFrameName([int]$Index) {
  return ("bootstrap-carousel-{0:D3}.bmp" -f $Index)
}

function Save-ImageAsBootstrapBmp(
  [object]$SourceImage,
  [string]$DestinationPath,
  [string]$AssetLabel
) {
  if ($SourceImage.Width -ne $carouselFrameWidth -or $SourceImage.Height -ne $carouselFrameHeight) {
    throw "$AssetLabel must be ${carouselFrameWidth}x${carouselFrameHeight}px, got $($SourceImage.Width)x$($SourceImage.Height)"
  }

  $bitmap = New-Object System.Drawing.Bitmap $carouselFrameWidth, $carouselFrameHeight, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::White)
      $graphics.DrawImage($SourceImage, 0, 0, $carouselFrameWidth, $carouselFrameHeight)
    } finally {
      $graphics.Dispose()
    }

    if (Test-Path -LiteralPath $DestinationPath) {
      Remove-Item -LiteralPath $DestinationPath -Force
    }
    $bitmap.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally {
    $bitmap.Dispose()
  }
}

function Convert-ImageToBootstrapBmp(
  [string]$SourcePath,
  [string]$DestinationPath,
  [string]$AssetLabel
) {
  Ensure-DrawingLoaded

  $sourceImage = [System.Drawing.Image]::FromFile($SourcePath)
  try {
    Save-ImageAsBootstrapBmp -SourceImage $sourceImage -DestinationPath $DestinationPath -AssetLabel "$AssetLabel ($SourcePath)"
  } finally {
    $sourceImage.Dispose()
  }
}

function Resolve-StaticCarouselAsset([object]$Asset) {
  foreach ($candidate in $Asset.Candidates) {
    $candidatePath = Join-Path $AssetsDir $candidate
    if (Test-Path -LiteralPath $candidatePath) {
      return $candidatePath
    }
  }

  throw "RC bootstrap carousel image not found for '$($Asset.Key)'. Expected one of: $($Asset.Candidates -join ', ')"
}

function Convert-GifToBootstrapFrames([string]$GifPath, [string]$TargetDir) {
  Ensure-DrawingLoaded

  $gif = [System.Drawing.Image]::FromFile($GifPath)
  try {
    if ($gif.Width -ne $carouselFrameWidth -or $gif.Height -ne $carouselFrameHeight) {
      throw "carousel.gif must be ${carouselFrameWidth}x${carouselFrameHeight}px, got $($gif.Width)x$($gif.Height): $GifPath"
    }

    $dimension = New-Object System.Drawing.Imaging.FrameDimension $gif.FrameDimensionsList[0]
    $frameCount = $gif.GetFrameCount($dimension)
    if ($frameCount -lt 1) {
      throw "carousel.gif contains no frames: $GifPath"
    }
    if ($frameCount -gt $MaxCarouselFrames) {
      throw "carousel.gif has $frameCount frames; keep it at $MaxCarouselFrames frames or fewer for the small installer."
    }

    for ($index = 0; $index -lt $frameCount; $index += 1) {
      $gif.SelectActiveFrame($dimension, $index) | Out-Null
      $targetPath = Join-Path $TargetDir (Get-BootstrapCarouselFrameName ($index + 1))
      Save-ImageAsBootstrapBmp -SourceImage $gif -DestinationPath $targetPath -AssetLabel "carousel.gif frame $($index + 1) ($GifPath)"
    }

    return [pscustomobject]@{
      Mode = "gif"
      FrameCount = $frameCount
      IntervalPolls = 1
    }
  } finally {
    $gif.Dispose()
  }
}

function Convert-FrameDirectoryToBootstrapFrames([string]$FramesDir, [string]$TargetDir) {
  $frameFiles = Get-ChildItem -LiteralPath $FramesDir -File |
    Where-Object { $_.Extension -match '^\.(bmp|png|jpg|jpeg)$' } |
    Sort-Object Name

  if ($frameFiles.Count -lt 1) {
    throw "carousel-frames exists but contains no .bmp/.png/.jpg/.jpeg files: $FramesDir"
  }
  if ($frameFiles.Count -gt $MaxCarouselFrames) {
    throw "carousel-frames has $($frameFiles.Count) frames; keep it at $MaxCarouselFrames frames or fewer for the small installer."
  }

  for ($index = 0; $index -lt $frameFiles.Count; $index += 1) {
    $targetPath = Join-Path $TargetDir (Get-BootstrapCarouselFrameName ($index + 1))
    Convert-ImageToBootstrapBmp -SourcePath $frameFiles[$index].FullName -DestinationPath $targetPath -AssetLabel "carousel-frames/$($frameFiles[$index].Name)"
  }

  return [pscustomobject]@{
    Mode = "frames"
    FrameCount = $frameFiles.Count
    IntervalPolls = 1
  }
}

function Convert-StaticCarouselToBootstrapFrames([string]$TargetDir) {
  for ($index = 0; $index -lt $carouselStaticAssets.Count; $index += 1) {
    $sourcePath = Resolve-StaticCarouselAsset -Asset $carouselStaticAssets[$index]
    $targetPath = Join-Path $TargetDir (Get-BootstrapCarouselFrameName ($index + 1))
    Convert-ImageToBootstrapBmp -SourcePath $sourcePath -DestinationPath $targetPath -AssetLabel "carousel-$($carouselStaticAssets[$index].Key)"
  }

  return [pscustomobject]@{
    Mode = "static"
    FrameCount = $carouselStaticAssets.Count
    IntervalPolls = 66
  }
}

function Prepare-BootstrapCarouselAssets([string]$TargetDir) {
  $staleTargets = Get-ChildItem -LiteralPath $TargetDir -File -Filter "bootstrap-carousel-*.bmp" -ErrorAction SilentlyContinue
  foreach ($staleTarget in $staleTargets) {
    Remove-Item -LiteralPath $staleTarget.FullName -Force
  }

  if (Test-Path -LiteralPath $carouselGifPath) {
    return Convert-GifToBootstrapFrames -GifPath $carouselGifPath -TargetDir $TargetDir
  }

  if (Test-Path -LiteralPath $carouselFramesDir) {
    return Convert-FrameDirectoryToBootstrapFrames -FramesDir $carouselFramesDir -TargetDir $TargetDir
  }

  return Convert-StaticCarouselToBootstrapFrames -TargetDir $TargetDir
}

function Write-BootstrapCarouselDownloaderScript([string]$Path) {
  $scriptSource = @'
# ABOUTME: Downloads optional runtime carousel frames for the Windows bootstrap installer.
param(
  [Parameter(Mandatory = $true)]
  [string]$ZipUrl,
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [Parameter(Mandatory = $true)]
  [string]$FrameCountFile,
  [int]$EmbeddedFrameCount = 0,
  [int]$MaxFrames = __MAX_CAROUSEL_FRAMES__,
  [int]$FrameWidth = 500,
  [int]$FrameHeight = 304,
  [int]$WelcomeWidth = 164,
  [int]$WelcomeHeight = 314,
  [int]$MaxZipBytes = 52428800,
  [string]$Locale = 'en-US'
)

$ErrorActionPreference = 'Stop'
$DebugDir = Join-Path $env:LOCALAPPDATA 'Floatboat'
$DebugLog = Join-Path $DebugDir 'bootstrap-carousel-debug.log'
$AsciiEncoding = [System.Text.Encoding]::ASCII

function Write-DebugLog([string]$Message) {
  try {
    if (-not (Test-Path -LiteralPath $DebugDir)) {
      [System.IO.Directory]::CreateDirectory($DebugDir) | Out-Null
    }

    $timestamp = [DateTime]::UtcNow.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
    [System.IO.File]::AppendAllText($DebugLog, "$timestamp $Message`r`n", [System.Text.Encoding]::UTF8)
  } catch {
  }
}

function Write-AtomicText([string]$Path, [string]$Content) {
  $parentDirectory = Split-Path -Parent $Path
  if ($parentDirectory -and -not (Test-Path -LiteralPath $parentDirectory)) {
    [System.IO.Directory]::CreateDirectory($parentDirectory) | Out-Null
  }

  $tmpPath = '{0}.{1}.{2}.tmp' -f $Path, $PID, ([System.Guid]::NewGuid().ToString('N'))
  [System.IO.File]::WriteAllText($tmpPath, $Content, $AsciiEncoding)

  try {
    [System.IO.File]::Copy($tmpPath, $Path, $true)
  } finally {
    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
  }
}

function Use-SystemProxy([System.Net.HttpWebRequest]$Request) {
  try {
    $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
    if ($null -ne $proxy) {
      $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
      $Request.Proxy = $proxy
    }
  } catch {
    Write-DebugLog ('system proxy setup failed: {0}' -f (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
  }
}

function Get-FrameName([int]$Index) {
  return ('bootstrap-carousel-{0:D3}.bmp' -f $Index)
}

function Get-SelectedCarouselLocaleDirectory([string]$Value) {
  $normalized = ([string]$Value).Trim().ToLowerInvariant()
  if ($normalized.StartsWith('zh')) {
    return 'zh'
  }

  return 'en'
}

function Save-ImageAsSizedBmp(
  [object]$SourceImage,
  [string]$DestinationPath,
  [string]$AssetLabel,
  [int]$Width,
  [int]$Height
) {
  if ($SourceImage.Width -ne $Width -or $SourceImage.Height -ne $Height) {
    throw "$AssetLabel must be ${Width}x${Height}px, got $($SourceImage.Width)x$($SourceImage.Height)"
  }

  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $tmpPath = '{0}.{1}.{2}.tmp' -f $DestinationPath, $PID, ([System.Guid]::NewGuid().ToString('N'))

  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::White)
      $graphics.DrawImage($SourceImage, 0, 0, $Width, $Height)
    } finally {
      $graphics.Dispose()
    }

    $bitmap.Save($tmpPath, [System.Drawing.Imaging.ImageFormat]::Bmp)

    $lastError = $null
    for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
      try {
        [System.IO.File]::Copy($tmpPath, $DestinationPath, $true)
        return
      } catch [System.IO.IOException] {
        $lastError = $_
        Start-Sleep -Milliseconds 25
      } catch [System.UnauthorizedAccessException] {
        $lastError = $_
        Start-Sleep -Milliseconds 25
      }
    }

    if ($null -ne $lastError) {
      throw $lastError.Exception
    }
  } finally {
    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
    $bitmap.Dispose()
  }
}

function Save-ImageAsFrame(
  [object]$SourceImage,
  [string]$DestinationPath,
  [string]$AssetLabel
) {
  Save-ImageAsSizedBmp -SourceImage $SourceImage -DestinationPath $DestinationPath -AssetLabel $AssetLabel -Width $FrameWidth -Height $FrameHeight
}

function Save-ZipEntryAsSizedBmp(
  [object]$Entry,
  [string]$DestinationPath,
  [string]$AssetLabel,
  [int]$Width,
  [int]$Height
) {
  $stream = $Entry.Open()
  try {
    $image = [System.Drawing.Image]::FromStream($stream, $false, $true)
    try {
      Save-ImageAsSizedBmp -SourceImage $image -DestinationPath $DestinationPath -AssetLabel $AssetLabel -Width $Width -Height $Height
    } finally {
      $image.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Save-ZipEntryAsFrame(
  [object]$Entry,
  [string]$DestinationPath,
  [string]$AssetLabel
) {
  Save-ZipEntryAsSizedBmp -Entry $Entry -DestinationPath $DestinationPath -AssetLabel $AssetLabel -Width $FrameWidth -Height $FrameHeight
}

function Download-Zip([string]$Url, [string]$Path) {
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.Method = 'GET'
  $request.Timeout = 15000
  $request.ReadWriteTimeout = 15000
  $request.AllowAutoRedirect = $true
  $request.UserAgent = 'Floatboat Bootstrap Carousel'
  Use-SystemProxy -Request $request

  $response = $request.GetResponse()
  try {
    if ($response.ContentLength -gt $MaxZipBytes) {
      throw "carousel zip is too large: $($response.ContentLength) bytes"
    }

    $inputStream = $response.GetResponseStream()
    $outputStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    $totalBytes = 0

    try {
      while ($true) {
        $read = $inputStream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) {
          break
        }

        $totalBytes += $read
        if ($totalBytes -gt $MaxZipBytes) {
          throw "carousel zip exceeded $MaxZipBytes bytes"
        }

        $outputStream.Write($buffer, 0, $read)
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
}

try {
  if ([string]::IsNullOrWhiteSpace($ZipUrl)) {
    exit 0
  }

  if (-not (Test-Path -LiteralPath $OutputDir)) {
    [System.IO.Directory]::CreateDirectory($OutputDir) | Out-Null
  }

  Write-DebugLog ('remote carousel start url={0}' -f $ZipUrl)
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) ('floatboat-carousel-{0}.zip' -f ([System.Guid]::NewGuid().ToString('N')))

  try {
    Download-Zip -Url $ZipUrl -Path $zipPath
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)

    try {
      $selectedLocaleDirectory = Get-SelectedCarouselLocaleDirectory -Value $Locale
      Write-DebugLog ('remote carousel locale={0} selected_dir={1}' -f $Locale, $selectedLocaleDirectory)

      $rootEntries = @()
      $localizedEntries = @()
      foreach ($entry in $archive.Entries) {
        if ([string]::IsNullOrWhiteSpace($entry.Name)) {
          continue
        }

        $normalizedName = ([string]$entry.FullName).Replace('\', '/').Trim('/')
        if ([string]::IsNullOrWhiteSpace($normalizedName)) {
          continue
        }

        $segments = @($normalizedName -split '/')
        if ($segments.Count -lt 1) {
          continue
        }
        if (([string]$segments[0]).ToLowerInvariant() -eq '__macosx') {
          continue
        }
        if ($entry.Name -eq '.DS_Store' -or $entry.Name.StartsWith('._')) {
          continue
        }
        if ($segments.Count -gt 1) {
          $firstSegment = ([string]$segments[0]).ToLowerInvariant()
          $secondSegment = ([string]$segments[1]).ToLowerInvariant()
          if ($firstSegment -notin @('zh', 'en') -and ($segments.Count -eq 2 -or $secondSegment -in @('zh', 'en'))) {
            $segments = @($segments | Select-Object -Skip 1)
          }
        }

        $extension = [System.IO.Path]::GetExtension($entry.Name).ToLowerInvariant()
        if ($extension -notin @('.bmp', '.png', '.jpg', '.jpeg')) {
          continue
        }

        $baseName = [System.IO.Path]::GetFileNameWithoutExtension($entry.Name)
        $numericIndex = $null
        $numericSort = [int]::MaxValue
        if ($baseName -match '^\d+$') {
          $numericIndex = [int]$baseName
          $numericSort = $numericIndex
        }

        $item = [pscustomobject]@{
          Index = $numericIndex
          SortIndex = $numericSort
          Entry = $entry
          Name = $entry.FullName
          FileName = $entry.Name
          TopDirectory = if ($segments.Count -gt 1) { ([string]$segments[0]).ToLowerInvariant() } else { '' }
        }

        if ($segments.Count -eq 1) {
          if ($null -ne $numericIndex -and $numericIndex -ge 1 -and $numericIndex -le $MaxFrames) {
            $rootEntries += $item
          }
          continue
        }

        if ($item.TopDirectory -eq $selectedLocaleDirectory) {
          $localizedEntries += $item
        }
      }

      $rootByIndex = @{}
      foreach ($item in ($rootEntries | Sort-Object Index, Name)) {
        if (-not $rootByIndex.ContainsKey($item.Index)) {
          $rootByIndex[$item.Index] = $item
        }
      }

      $processed = @{}
      $remoteCarouselFrameCount = 0
      $usesProductZipLayout = $localizedEntries.Count -gt 0

      if ($rootByIndex.ContainsKey(1)) {
        $welcomeItem = $rootByIndex[1]
        try {
          $welcomePath = Join-Path $OutputDir 'bootstrap-welcome-product.bmp'
          Save-ZipEntryAsSizedBmp -Entry $welcomeItem.Entry -DestinationPath $welcomePath -AssetLabel $welcomeItem.Name -Width $WelcomeWidth -Height $WelcomeHeight
          $usesProductZipLayout = $true
          Write-DebugLog ('remote welcome image ready source={0}' -f $welcomeItem.Name)
        } catch {
          Write-DebugLog ('remote welcome image skipped source={0} error={1}' -f $welcomeItem.Name, (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
        }
      }

      if ($usesProductZipLayout) {
        $nextFrameIndex = 1

        if ($rootByIndex.ContainsKey(2)) {
          $firstCarouselItem = $rootByIndex[2]
          try {
            $destinationPath = Join-Path $OutputDir (Get-FrameName -Index $nextFrameIndex)
            Save-ZipEntryAsFrame -Entry $firstCarouselItem.Entry -DestinationPath $destinationPath -AssetLabel $firstCarouselItem.Name
            $processed[$nextFrameIndex] = $true
            $remoteCarouselFrameCount = [Math]::Max($remoteCarouselFrameCount, $nextFrameIndex)
            Write-DebugLog ('remote carousel frame ready index={0} source={1}' -f $nextFrameIndex, $firstCarouselItem.Name)
            $nextFrameIndex += 1
          } catch {
            Write-DebugLog ('remote carousel frame skipped source={0} error={1}' -f $firstCarouselItem.Name, (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
          }
        } else {
          Write-DebugLog 'remote carousel product zip has no root 2.* first product frame'
        }

        foreach ($item in ($localizedEntries | Sort-Object SortIndex, FileName, Name)) {
          if ($nextFrameIndex -gt $MaxFrames) {
            break
          }

          try {
            $destinationPath = Join-Path $OutputDir (Get-FrameName -Index $nextFrameIndex)
            Save-ZipEntryAsFrame -Entry $item.Entry -DestinationPath $destinationPath -AssetLabel $item.Name
            $processed[$nextFrameIndex] = $true
            $remoteCarouselFrameCount = [Math]::Max($remoteCarouselFrameCount, $nextFrameIndex)
            Write-DebugLog ('remote carousel frame ready index={0} locale={1} source={2}' -f $nextFrameIndex, $selectedLocaleDirectory, $item.Name)
            $nextFrameIndex += 1
          } catch {
            Write-DebugLog ('remote carousel frame skipped source={0} error={1}' -f $item.Name, (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
          }
        }
      } else {
        foreach ($item in ($rootEntries | Sort-Object Index, Name)) {
          if ($processed.ContainsKey($item.Index)) {
            continue
          }

          try {
            $destinationPath = Join-Path $OutputDir (Get-FrameName -Index $item.Index)
            Save-ZipEntryAsFrame -Entry $item.Entry -DestinationPath $destinationPath -AssetLabel $item.Name
            $processed[$item.Index] = $true
            $remoteCarouselFrameCount = [Math]::Max($remoteCarouselFrameCount, $item.Index)
            Write-DebugLog ('remote carousel legacy frame ready index={0} source={1}' -f $item.Index, $item.Name)
          } catch {
            Write-DebugLog ('remote carousel legacy frame skipped source={0} error={1}' -f $item.Name, (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
          }
        }
      }

      if ($processed.Count -gt 0) {
        if ($usesProductZipLayout) {
          if ($remoteCarouselFrameCount -gt 0) {
            Write-AtomicText -Path $FrameCountFile -Content ([string]$remoteCarouselFrameCount)
            Write-DebugLog ('remote carousel enabled product zip frames={0}' -f $remoteCarouselFrameCount)
          } else {
            Write-DebugLog 'remote carousel product zip had no usable carousel frames'
          }
        } else {
          $frameCount = [Math]::Min([Math]::Max(0, $EmbeddedFrameCount), $MaxFrames)
          for ($index = $frameCount + 1; $index -le $MaxFrames; $index += 1) {
            $framePath = Join-Path $OutputDir (Get-FrameName -Index $index)
            if (-not (Test-Path -LiteralPath $framePath)) {
              break
            }

            $frameCount = $index
          }

          if ($frameCount -gt $EmbeddedFrameCount) {
            Write-AtomicText -Path $FrameCountFile -Content ([string]$frameCount)
            Write-DebugLog ('remote carousel enabled legacy frames={0}' -f $frameCount)
          } else {
            Write-DebugLog ('remote carousel legacy frames converted without count increase processed={0}' -f $processed.Count)
          }
        }
      } else {
        Write-DebugLog 'remote carousel zip contained no usable image frames'
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-DebugLog ('remote carousel failed: {0}' -f (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
}

exit 0
'@

  $scriptSource = $scriptSource.Replace('__MAX_CAROUSEL_FRAMES__', [string]$MaxCarouselFrames)
  Write-Utf8BomFile -Path $Path -Content $scriptSource
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

if (-not (Test-Path -LiteralPath $launchHiddenScriptPath)) {
  throw "RC bootstrap launcher script not found: $launchHiddenScriptPath"
}

if (-not (Test-Path -LiteralPath $welcomeAssetPath)) {
  throw "RC bootstrap welcome image not found: $welcomeAssetPath"
}

Copy-Item -LiteralPath $welcomeAssetPath -Destination $targetWelcomeAssetPath -Force
$carouselAssetPlan = Prepare-BootstrapCarouselAssets -TargetDir $InstallerDir
Write-BootstrapCarouselDownloaderScript -Path $bootstrapCarouselScriptPath

$source = Read-TextFile -Path $nsiPath
$newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }
$carouselFileLines = ((1..([int]$carouselAssetPlan.FrameCount)) | ForEach-Object {
  $frameName = Get-BootstrapCarouselFrameName $_
  return ('  File /oname=$PLUGINSDIR\{0} "{0}"' -f $frameName)
}) -join $newline

if (-not $source.Contains('!define MUI_WELCOMEFINISHPAGE_BITMAP "bootstrap-welcome-product.bmp"')) {
  $source = $source.Replace(
    '!define MUI_UNICON "..\..\resources\icon.ico"',
    "!define MUI_UNICON `"..\..\resources\icon.ico`"${newline}!define MUI_WELCOMEFINISHPAGE_BITMAP `"bootstrap-welcome-product.bmp`""
  )
}

$escapedRemoteCarouselZipUrl = Escape-NsisQuotedValue $RemoteCarouselZipUrl
$remoteCarouselDefineBlock = Convert-Newlines -Newline $newline -Content @"
!ifndef FLOATBOAT_REMOTE_CAROUSEL_ZIP_URL
!define FLOATBOAT_REMOTE_CAROUSEL_ZIP_URL "$escapedRemoteCarouselZipUrl"
!endif
"@
$remoteCarouselDefinePattern = '(?ms)!ifndef FLOATBOAT_REMOTE_CAROUSEL_ZIP_URL\r?\n!define FLOATBOAT_REMOTE_CAROUSEL_ZIP_URL ".*?"\r?\n!endif'
if ([regex]::IsMatch($source, $remoteCarouselDefinePattern)) {
  $source = [regex]::Replace(
    $source,
    $remoteCarouselDefinePattern,
    [System.Text.RegularExpressions.MatchEvaluator] { param($match) $remoteCarouselDefineBlock },
    1
  )
} elseif ($source.Contains('!define MUI_WELCOMEFINISHPAGE_BITMAP "bootstrap-welcome-product.bmp"')) {
  $source = $source.Replace(
    '!define MUI_WELCOMEFINISHPAGE_BITMAP "bootstrap-welcome-product.bmp"',
    "!define MUI_WELCOMEFINISHPAGE_BITMAP `"bootstrap-welcome-product.bmp`"${newline}$remoteCarouselDefineBlock"
  )
} else {
  throw "Unable to patch remote carousel URL define in $nsiPath"
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
    "Var DownloadPollEmptyTicks${newline}Var BootstrapPageDialogHandle${newline}Var BootstrapImageHandle${newline}Var BootstrapTitleHandle${newline}Var BootstrapSubtitleHandle${newline}Var BootstrapStatusHandle${newline}Var BootstrapMetaHandle${newline}Var BootstrapPercentHandle${newline}Var BootstrapHintHandle${newline}Var BootstrapCarouselFrameCountFile${newline}Var BootstrapRemoteCarouselUrl${newline}Var ProductCarouselBitmap${newline}Var ProductCarouselFrame${newline}Var ProductCarouselTick${newline}Var ProductCarouselFrameCount"
  )
}

if (-not $source.Contains("Var BootstrapRemoteCarouselUrl")) {
  $source = $source.Replace(
    "Var ProductCarouselTick",
    "Var ProductCarouselTick${newline}Var ProductCarouselFrameCount${newline}Var BootstrapCarouselFrameCountFile${newline}Var BootstrapRemoteCarouselUrl"
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
!define FLOATBOAT_CAROUSEL_FRAME_COUNT __CAROUSEL_FRAME_COUNT__
!define FLOATBOAT_CAROUSEL_FRAME_INTERVAL_POLLS __CAROUSEL_FRAME_INTERVAL_POLLS__
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
__CAROUSEL_FILE_LINES__

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

  StrCpy $ProductCarouselFrame 1
  StrCpy $ProductCarouselTick 0
  StrCpy $ProductCarouselFrameCount ${FLOATBOAT_CAROUSEL_FRAME_COUNT}
  Call BootstrapSetProductCarouselFrame
FunctionEnd

Function BootstrapSetProductCarouselFrame
  ${If} $BootstrapImageHandle == ""
    Return
  ${EndIf}
  ${If} $BootstrapImageHandle == 0
    Return
  ${EndIf}

  IntFmt $0 "%03d" $ProductCarouselFrame
  System::Call 'USER32::LoadImageW(p 0, w "$PLUGINSDIR\bootstrap-carousel-$0.bmp", i ${FLOATBOAT_IMAGE_BITMAP}, i 0, i 0, i ${FLOATBOAT_LR_BITMAP_FLAGS}) p.r0'
  ${If} $0 == 0
    Return
  ${EndIf}

  ${If} $ProductCarouselBitmap != ""
  ${AndIf} $ProductCarouselBitmap != 0
    System::Call 'GDI32::DeleteObject(p $ProductCarouselBitmap)'
  ${EndIf}

  StrCpy $ProductCarouselBitmap $0
  SendMessage $BootstrapImageHandle ${FLOATBOAT_STM_SETIMAGE} ${FLOATBOAT_IMAGE_BITMAP} $ProductCarouselBitmap
  System::Call 'USER32::InvalidateRect(p $BootstrapImageHandle, p 0, i 1)'
  System::Call 'USER32::UpdateWindow(p $BootstrapImageHandle)'
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

Function BootstrapRefreshProductCarouselFrameCount
  ${If} $BootstrapCarouselFrameCountFile == ""
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$BootstrapCarouselFrameCountFile"
    Return
  ${EndIf}

  !insertmacro ReadValueFile "$BootstrapCarouselFrameCountFile" $0
  ${If} $0 == ""
    Return
  ${EndIf}
  Delete "$BootstrapCarouselFrameCountFile"

  ${If} $0 > 0
    StrCpy $ProductCarouselFrameCount $0
    StrCpy $ProductCarouselFrame 1
    StrCpy $ProductCarouselTick 0
    Call BootstrapSetProductCarouselFrame
  ${EndIf}
FunctionEnd

Function BootstrapUpdateProductCarousel
  Call BootstrapRefreshProductCarouselFrameCount
  ${If} $ProductCarouselFrameCount == ""
    StrCpy $ProductCarouselFrameCount ${FLOATBOAT_CAROUSEL_FRAME_COUNT}
  ${EndIf}
  ${If} $ProductCarouselFrameCount <= 1
    Return
  ${EndIf}
  ${If} $BootstrapImageHandle == ""
    Return
  ${EndIf}
  ${If} $BootstrapImageHandle == 0
    Return
  ${EndIf}

  IntOp $ProductCarouselTick $ProductCarouselTick + 1
  ${If} $ProductCarouselTick < ${FLOATBOAT_CAROUSEL_FRAME_INTERVAL_POLLS}
    Return
  ${EndIf}

  StrCpy $ProductCarouselTick 0
  IntOp $ProductCarouselFrame $ProductCarouselFrame + 1
  ${If} $ProductCarouselFrame > $ProductCarouselFrameCount
    StrCpy $ProductCarouselFrame 1
  ${EndIf}
  Call BootstrapSetProductCarouselFrame
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

  ${If} $ProductCarouselBitmap != ""
  ${AndIf} $ProductCarouselBitmap != 0
    System::Call 'GDI32::DeleteObject(p $ProductCarouselBitmap)'
    StrCpy $ProductCarouselBitmap ""
  ${EndIf}
FunctionEnd
'@

  $functionBlock = $functionBlock.Replace('__CAROUSEL_FRAME_COUNT__', [string]$carouselAssetPlan.FrameCount)
  $functionBlock = $functionBlock.Replace('__CAROUSEL_FRAME_INTERVAL_POLLS__', [string]$carouselAssetPlan.IntervalPolls)
  $functionBlock = $functionBlock.Replace('__CAROUSEL_FILE_LINES__', $carouselFileLines)

  $source = $source.Replace(
    "Function BootstrapAbortCleanup",
    "$functionBlock${newline}Function BootstrapAbortCleanup"
  )
}

$oldCarouselFrameCountRefreshBlock = Convert-Newlines -Newline $newline -Content @'
  ${If} $0 > $ProductCarouselFrameCount
    StrCpy $ProductCarouselFrameCount $0
  ${EndIf}
'@

$newCarouselFrameCountRefreshBlock = Convert-Newlines -Newline $newline -Content @'
  Delete "$BootstrapCarouselFrameCountFile"

  ${If} $0 > 0
    StrCpy $ProductCarouselFrameCount $0
    StrCpy $ProductCarouselFrame 1
    StrCpy $ProductCarouselTick 0
    Call BootstrapSetProductCarouselFrame
  ${EndIf}
'@

if ($source.Contains($oldCarouselFrameCountRefreshBlock)) {
  $source = $source.Replace($oldCarouselFrameCountRefreshBlock, $newCarouselFrameCountRefreshBlock)
}

$oldCarouselFrameCountRefreshResetBlock = Convert-Newlines -Newline $newline -Content @'
  ${If} $0 > 0
    StrCpy $ProductCarouselFrameCount $0
    ${If} $ProductCarouselFrame > $ProductCarouselFrameCount
      StrCpy $ProductCarouselFrame 1
    ${EndIf}
  ${EndIf}
'@

if ($source.Contains($oldCarouselFrameCountRefreshResetBlock)) {
  $source = $source.Replace($oldCarouselFrameCountRefreshResetBlock, $newCarouselFrameCountRefreshBlock)
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

if (-not $source.Contains("StrCpy `$BootstrapCarouselFrameCountFile")) {
  $source = $source.Replace(
    "  StrCpy `$DownloadPidFile `"`$PLUGINSDIR\download.pid`"",
    "  StrCpy `$DownloadPidFile `"`$PLUGINSDIR\download.pid`"${newline}  StrCpy `$BootstrapCarouselFrameCountFile `"`$PLUGINSDIR\bootstrap-carousel-count.value`"${newline}  Delete `"`$BootstrapCarouselFrameCountFile`""
  )
}

if (-not $source.Contains("ReadEnvStr `$BootstrapRemoteCarouselUrl")) {
  $oldAttributionEndpointBlock = Convert-Newlines -Newline $newline -Content @'
  ReadEnvStr $AttributionEventEndpoint "FLOATBOAT_ATTRIBUTION_EVENT_ENDPOINT"
  ${If} $AttributionEventEndpoint == ""
    StrCpy $AttributionEventEndpoint "${ATTRIBUTION_EVENT_ENDPOINT}"
  ${EndIf}
'@

  $newAttributionEndpointBlock = Convert-Newlines -Newline $newline -Content @'
  ReadEnvStr $AttributionEventEndpoint "FLOATBOAT_ATTRIBUTION_EVENT_ENDPOINT"
  ${If} $AttributionEventEndpoint == ""
    StrCpy $AttributionEventEndpoint "${ATTRIBUTION_EVENT_ENDPOINT}"
  ${EndIf}

  ReadEnvStr $BootstrapRemoteCarouselUrl "FLOATBOAT_BOOTSTRAP_CAROUSEL_ZIP_URL"
  ${If} $BootstrapRemoteCarouselUrl == ""
    StrCpy $BootstrapRemoteCarouselUrl "${FLOATBOAT_REMOTE_CAROUSEL_ZIP_URL}"
  ${EndIf}
'@

  if (-not $source.Contains($oldAttributionEndpointBlock)) {
    throw "Unable to patch remote carousel URL setup in $nsiPath"
  }

  $source = $source.Replace($oldAttributionEndpointBlock, $newAttributionEndpointBlock)
}

if (-not $source.Contains('File /oname=$PLUGINSDIR\bootstrap-carousel.ps1 "bootstrap-carousel.ps1"')) {
  $oldBootstrapFileBlock = Convert-Newlines -Newline $newline -Content @'
  File /oname=$PLUGINSDIR\send-installer-event.ps1 "send-installer-event.ps1"
  File /oname=$PLUGINSDIR\download-installer.ps1 "download-installer.ps1"
  File /oname=$PLUGINSDIR\launch-hidden.vbs "launch-hidden.vbs"
'@

  $newBootstrapFileBlock = Convert-Newlines -Newline $newline -Content @'
  File /oname=$PLUGINSDIR\send-installer-event.ps1 "send-installer-event.ps1"
  File /oname=$PLUGINSDIR\download-installer.ps1 "download-installer.ps1"
  File /oname=$PLUGINSDIR\bootstrap-carousel.ps1 "bootstrap-carousel.ps1"
  File /oname=$PLUGINSDIR\launch-hidden.vbs "launch-hidden.vbs"
'@

  if (-not $source.Contains($oldBootstrapFileBlock)) {
    throw "Unable to patch remote carousel script inclusion in $nsiPath"
  }

  $source = $source.Replace($oldBootstrapFileBlock, $newBootstrapFileBlock)
}

if (-not $source.Contains('"$PLUGINSDIR\launch-hidden.vbs" "carousel"')) {
  $oldInstallClickBlock = Convert-Newlines -Newline $newline -Content @'
  !insertmacro SendEvent "install_click"

  DetailPrint "$(TXT_DOWNLOADING)"
'@

  $newInstallClickBlock = Convert-Newlines -Newline $newline -Content @'
  !insertmacro SendEvent "install_click"

  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$PowerShellPath"
    StrCpy $PowerShellPath "powershell.exe"
  ${EndIf}

  ${If} $BootstrapRemoteCarouselUrl != ""
    ExecWait '"$SYSDIR\wscript.exe" "$PLUGINSDIR\launch-hidden.vbs" "carousel" "$PowerShellPath" "$PLUGINSDIR\bootstrap-carousel.ps1" "$BootstrapRemoteCarouselUrl" "$PLUGINSDIR" "$BootstrapCarouselFrameCountFile" "${FLOATBOAT_CAROUSEL_FRAME_COUNT}" "$DownloadLocale"' $0
    !insertmacro LogDebug "remote_carousel_launch code=$0 url=$BootstrapRemoteCarouselUrl"
  ${EndIf}

  DetailPrint "$(TXT_DOWNLOADING)"
'@

  if (-not $source.Contains($oldInstallClickBlock)) {
    throw "Unable to patch remote carousel launch in $nsiPath"
  }

  $source = $source.Replace($oldInstallClickBlock, $newInstallClickBlock)
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
  '!define FLOATBOAT_REMOTE_CAROUSEL_ZIP_URL',
  'BrandingText " "',
  '!define MUI_PAGE_CUSTOMFUNCTION_SHOW BootstrapInstFilesShow',
  'LangString TXT_READY_TO_LAUNCH',
  'Var BootstrapPageDialogHandle',
  'Var BootstrapRemoteCarouselUrl',
  'Var ProductCarouselFrameCount',
  'Var DownloadStateStableTicks',
  'Var BootstrapSubtitleHandle',
  '!define FLOATBOAT_LR_BITMAP_FLAGS',
  '!define FLOATBOAT_CAROUSEL_FRAME_COUNT',
  'Function BootstrapInstFilesShow',
  'Function BootstrapSetProductCarouselFrame',
  'Function BootstrapRefreshProductCarouselFrameCount',
  'Function BootstrapResizeAndCleanWindow',
  'BootstrapHideParentControl',
  'ReadEnvStr $BootstrapRemoteCarouselUrl "FLOATBOAT_BOOTSTRAP_CAROUSEL_ZIP_URL"',
  'File /oname=$PLUGINSDIR\bootstrap-carousel.ps1 "bootstrap-carousel.ps1"',
  '"$PLUGINSDIR\launch-hidden.vbs" "carousel"',
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

$launchHiddenSource = Read-TextFile -Path $launchHiddenScriptPath
if (-not $launchHiddenSource.Contains('mode = "carousel"')) {
  $launchHiddenNewline = if ($launchHiddenSource.Contains("`r`n")) { "`r`n" } else { "`n" }
  $oldLaunchHiddenBlock = Convert-Newlines -Newline $launchHiddenNewline -Content @'
If WScript.Arguments.Count < 11 Then
  WScript.Quit 1
End If

Dim shell
Dim exePath
Dim scriptPath
Dim url
Dim outFile
Dim progressFile
Dim progressTextFile
Dim statusFile
Dim metaFile
Dim stateFile
Dim pidFile
Dim locale
Dim cmd

Set shell = CreateObject("WScript.Shell")
'@

  $newLaunchHiddenBlock = Convert-Newlines -Newline $launchHiddenNewline -Content @'
If WScript.Arguments.Count < 11 Then
  If WScript.Arguments.Count < 1 Then
    WScript.Quit 1
  End If
  If WScript.Arguments(0) <> "carousel" Then
    WScript.Quit 1
  End If
  If WScript.Arguments.Count < 8 Then
    WScript.Quit 1
  End If
End If

Dim shell
Dim exePath
Dim scriptPath
Dim url
Dim outFile
Dim progressFile
Dim progressTextFile
Dim statusFile
Dim metaFile
Dim stateFile
Dim pidFile
Dim locale
Dim mode
Dim carouselZipUrl
Dim carouselOutputDir
Dim carouselFrameCountFile
Dim embeddedCarouselFrameCount
Dim cmd

Set shell = CreateObject("WScript.Shell")

mode = ""
If WScript.Arguments.Count > 0 Then
  mode = WScript.Arguments(0)
End If

If mode = "carousel" Then
  exePath = WScript.Arguments(1)
  scriptPath = WScript.Arguments(2)
  carouselZipUrl = WScript.Arguments(3)
  carouselOutputDir = WScript.Arguments(4)
  carouselFrameCountFile = WScript.Arguments(5)
  embeddedCarouselFrameCount = WScript.Arguments(6)
  locale = WScript.Arguments(7)

  cmd = """" & exePath & """ -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """" & _
        " -ZipUrl """ & carouselZipUrl & """" & _
        " -OutputDir """ & carouselOutputDir & """" & _
        " -FrameCountFile """ & carouselFrameCountFile & """" & _
        " -EmbeddedFrameCount """ & embeddedCarouselFrameCount & """" & _
        " -Locale """ & locale & """"

  On Error Resume Next
  shell.Run cmd, 0, False
  If Err.Number <> 0 Then
    WScript.Quit Err.Number
  End If

  WScript.Quit 0
End If
'@

  if (-not $launchHiddenSource.Contains($oldLaunchHiddenBlock)) {
    throw "Unable to patch remote carousel launcher in $launchHiddenScriptPath"
  }

  $launchHiddenSource = $launchHiddenSource.Replace($oldLaunchHiddenBlock, $newLaunchHiddenBlock)
  Write-Utf8NoBomFile -Path $launchHiddenScriptPath -Content $launchHiddenSource
}

$launchHiddenSource = Read-TextFile -Path $launchHiddenScriptPath
$launchHiddenRequiredSnippets = @(
  'mode = "carousel"',
  '-ZipUrl',
  '-EmbeddedFrameCount'
)

foreach ($snippet in $launchHiddenRequiredSnippets) {
  if (-not $launchHiddenSource.Contains($snippet)) {
    throw "RC bootstrap launcher patch is incomplete; missing snippet: $snippet"
  }
}

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
      [System.IO.File]::Copy($tmpPath, $Path, $true)
      [System.IO.File]::Delete($tmpPath)
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
  -RequiredSnippet '[System.IO.File]::Copy($tmpPath, $Path, $true)' `
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

  $downloadDebugDir = Join-Path $env:LOCALAPPDATA 'Floatboat'
  $downloadDebugLog = Join-Path $downloadDebugDir 'bootstrap-download-debug.log'

  function Write-DownloadDebug([string]$Message) {
    try {
      if (-not (Test-Path -LiteralPath $downloadDebugDir)) {
        [System.IO.Directory]::CreateDirectory($downloadDebugDir) | Out-Null
      }

      $timestamp = [DateTime]::UtcNow.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
      [System.IO.File]::AppendAllText($downloadDebugLog, "$timestamp $Message`r`n", [System.Text.Encoding]::UTF8)
    } catch {
    }
  }

  function Use-SystemProxy([System.Net.HttpWebRequest]$Request) {
    try {
      $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
      if ($null -ne $proxy) {
        $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
        $Request.Proxy = $proxy
      }
    } catch {
      Write-DownloadDebug ('system proxy setup failed: {0}' -f (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim()))
    }
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
      '--user-agent', 'Floatboat Bootstrap Installer RC',
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
    $partialFile = "$OutFile.download"
    Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue

    Reset-DownloadProgressVariables `
      -StatusLine (Get-Text -English "Connecting through Windows background transfer $SourceIndex of $SourceCount" -Chinese "正在通过 Windows 后台传输连接下载源 $SourceIndex/$SourceCount") `
      -MetaLine (Get-Text -English '0.00% | Windows BITS download' -Chinese '0.00% | 正在通过 Windows BITS 下载')

    Import-Module BitsTransfer -ErrorAction Stop

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
    $request.AllowAutoRedirect = $true
    $request.UserAgent = 'Floatboat Bootstrap Installer RC'
    Use-SystemProxy -Request $request
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
  Write-DownloadDebug ('download start urls={0}' -f ($downloadUrls -join ' | '))
  for ($sourceIndex = 0; $sourceIndex -lt $downloadUrls.Count; $sourceIndex += 1) {
    $sourceNumber = $sourceIndex + 1
    $candidateUrl = $downloadUrls[$sourceIndex]

    try {
      Write-DownloadDebug ('source {0} curl start {1}' -f $sourceNumber, $candidateUrl)
      Invoke-CurlDownload -DownloadUrl $candidateUrl -SourceIndex $sourceNumber -SourceCount $downloadUrls.Count
      $downloadCompleted = $true
      break
    } catch {
      $errorMessage = (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim())
      Write-DownloadDebug ('source {0} curl failed: {1}' -f $sourceNumber, $errorMessage)
      $downloadErrors += ('source {0} curl: {1}' -f $sourceNumber, $errorMessage)
    }

    try {
      Write-DownloadDebug ('source {0} powershell start {1}' -f $sourceNumber, $candidateUrl)
      Invoke-DotNetDownload -DownloadUrl $candidateUrl -SourceIndex $sourceNumber -SourceCount $downloadUrls.Count
      $downloadCompleted = $true
      break
    } catch {
      $errorMessage = (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim())
      Write-DownloadDebug ('source {0} powershell failed: {1}' -f $sourceNumber, $errorMessage)
      $downloadErrors += ('source {0} powershell: {1}' -f $sourceNumber, $errorMessage)
    }

    try {
      Write-DownloadDebug ('source {0} bits start {1}' -f $sourceNumber, $candidateUrl)
      Invoke-BitsDownload -DownloadUrl $candidateUrl -SourceIndex $sourceNumber -SourceCount $downloadUrls.Count
      $downloadCompleted = $true
      break
    } catch {
      $errorMessage = (($_.Exception.Message -replace '\r', ' ' -replace '\n', ' ').Trim())
      Write-DownloadDebug ('source {0} bits failed: {1}' -f $sourceNumber, $errorMessage)
      $downloadErrors += ('source {0} bits: {1}' -f $sourceNumber, $errorMessage)
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
    Write-DownloadDebug ('download failed: {0}' -f $joinedErrors)
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

$downloadSource = Read-TextFile -Path $downloadScriptPath
$downloadRequiredSnippets = @(
  'Write-DownloadDebug',
  'Use-SystemProxy',
  "'--user-agent', 'Floatboat Bootstrap Installer RC'",
  "Write-DownloadDebug ('source {0} curl start {1}'",
  "Write-DownloadDebug ('source {0} powershell start {1}'",
  "Write-DownloadDebug ('source {0} bits start {1}'"
)

foreach ($snippet in $downloadRequiredSnippets) {
  if (-not $downloadSource.Contains($snippet)) {
    throw "RC downloader patch is incomplete; missing snippet: $snippet"
  }
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
      [System.IO.File]::Copy($temporaryPath, $Path, $true)
      [System.IO.File]::Delete($temporaryPath)
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
  -RequiredSnippet '[System.IO.File]::Copy($temporaryPath, $Path, $true)' `
  -WriteBom $false

Write-Host "Prepared RC bootstrap branding:"
Write-Host "  installer script: $nsiPath"
Write-Host "  downloader script: $downloadScriptPath"
Write-Host "  setup progress script: $setupProgressScriptPath"
Write-Host "  welcome image:    $targetWelcomeAssetPath"
Write-Host "  carousel media:   mode=$($carouselAssetPlan.Mode), frames=$($carouselAssetPlan.FrameCount), intervalPolls=$($carouselAssetPlan.IntervalPolls)"
Write-Host "  remote carousel:  $RemoteCarouselZipUrl"
Write-Host "  custom page:      enlarged window with hidden default header/details"
Write-Host "  downloader:       release.aoe.chat via curl first, then PowerShell system proxy, then BITS"
Write-Host "  launch delay:     ${LaunchDelayMs}ms"
