# ABOUTME: 在一次性 Windows runner 上对同载荷安装器执行 AB/BA/AB/BA；只计升级进程寿命，校验在计时外完成。
#requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BuildReceipt,
  [Parameter(Mandatory)][string]$PayloadManifest,
  [Parameter(Mandatory)][string]$ExpectedVersion,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [ValidateRange(60,1200)][int]$TimeoutSeconds = 900
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Only an isolated GitHub-hosted Windows runner is supported.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated runner is required.' }
$root = 'C:\Program Files\Floatboat'
$userRoot = Join-Path $env:APPDATA 'floatboat'
$cacheRoot = Join-Path $env:LOCALAPPDATA 'floatboat-updater'
$output = [IO.Path]::GetFullPath($OutputDirectory)
$runToken = [Guid]::NewGuid().ToString('N')
$invocations = [Collections.Generic.List[object]]::new()
$samples = [Collections.Generic.List[object]]::new()
$failure = $null
$sentinel = Join-Path $userRoot ('installer-performance-' + $runToken + '.txt')
$unknownFile = Join-Path $root ('installer-performance-' + $runToken + '.txt')
$desktop = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Floatboat.lnk'
$menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Floatboat.lnk'
$encoding = [Text.UTF8Encoding]::new($false)

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 12), $encoding) }
function Assert-NoReparse([string]$Path) {
  $current = $Path
  while ($current) {
    if (Test-Path -LiteralPath $current) { Assert (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Reparse path rejected: $current" }
    $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
    if ($parent -eq $current) { break }; $current = $parent
  }
}
function Tree-Files([string]$Path) {
  Assert-NoReparse $Path
  $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($Path)
  while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      Assert (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Reparse entry rejected: $($entry.FullName)"
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
      else { $entry }
    }
  }
}
function Registrations {
  foreach ($hive in @('LocalMachine','CurrentUser')) {
    foreach ($view in @('Registry64','Registry32')) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
      $parent = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
      try {
        if ($null -eq $parent) { continue }
        foreach ($name in $parent.GetSubKeyNames()) {
          $key = $parent.OpenSubKey($name)
          try {
            if ([string]$key.GetValue('DisplayName','') -ne 'Floatboat') { continue }
            $installKey = $base.OpenSubKey('Software\' + $name)
            try {
              [pscustomobject]@{ hive=$hive;view=$view;key=$name;version=[string]$key.GetValue('DisplayVersion','');uninstall=[string]$key.GetValue('UninstallString','');location=$(if($null -eq $installKey){''}else{[string]$installKey.GetValue('InstallLocation','')}) }
            } finally { if ($null -ne $installKey) { $installKey.Dispose() } }
          } finally { $key.Dispose() }
        }
      } finally { if ($null -ne $parent) { $parent.Dispose() }; $base.Dispose() }
    }
  }
}
function Signature([string]$Path) {
  $value = Get-AuthenticodeSignature -LiteralPath $Path
  return [pscustomobject]@{ path=$Path;status=$value.Status.ToString();subject=$(if($null -ne $value.SignerCertificate){$value.SignerCertificate.Subject}else{$null});thumbprint=$(if($null -ne $value.SignerCertificate){$value.SignerCertificate.Thumbprint}else{$null});sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
}
function InstallLocationKeys {
  foreach ($hive in @('LocalMachine','CurrentUser')) {
    foreach ($view in @('Registry64','Registry32')) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
      try {
        $key = $base.OpenSubKey('Software\' + $receipt.appGuid)
        if ($null -ne $key) { try { [pscustomobject]@{hive=$hive;view=$view;location=$key.GetValue('InstallLocation','')} } finally {$key.Dispose()} }
      } finally {$base.Dispose()}
    }
  }
}
function Installed-Version {
  $stream = [IO.File]::OpenRead((Join-Path $root 'resources\app.asar'))
  $reader = [IO.BinaryReader]::new($stream)
  try {
    $prefix = $reader.ReadBytes(16)
    Assert ($prefix.Length -eq 16) 'ASAR header is truncated.'
    $headerSize = [BitConverter]::ToUInt32($prefix,4); $jsonSize = [BitConverter]::ToUInt32($prefix,12)
    Assert ($jsonSize -gt 0 -and $jsonSize -lt 64MB -and $headerSize -ge $jsonSize) 'Invalid ASAR header size.'
    $headerBytes = $reader.ReadBytes($jsonSize); Assert ($headerBytes.Length -eq $jsonSize) 'ASAR header is truncated.'
    $header = [Text.Encoding]::UTF8.GetString($headerBytes) | ConvertFrom-Json -AsHashtable
    $entry = $header.files['package.json']; Assert ($null -ne $entry -and $entry.size -gt 0 -and $entry.size -lt 1MB -and [string]$entry.offset -match '^\d+$') 'Invalid ASAR package.json entry.'
    $null = $stream.Seek(8L + $headerSize + [long]$entry.offset,[IO.SeekOrigin]::Begin)
    $data = $reader.ReadBytes([int]$entry.size); Assert ($data.Length -eq $entry.size) 'ASAR package.json is truncated.'
    return ([Text.Encoding]::UTF8.GetString($data) | ConvertFrom-Json).version
  } finally { $reader.Dispose() }
}
function Invoke-Installer([string]$Label,[string]$Executable,[string]$Arguments) {
  $case = Join-Path $output $Label; [IO.Directory]::CreateDirectory($case) | Out-Null
  $temporary = Join-Path $case 'temp'; [IO.Directory]::CreateDirectory($temporary) | Out-Null
  $start = [Diagnostics.ProcessStartInfo]::new($Executable,$Arguments)
  $start.UseShellExecute = $false; $start.WorkingDirectory = $case
  $start.Environment['TEMP'] = $temporary; $start.Environment['TMP'] = $temporary
  $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
  $watch = [Diagnostics.Stopwatch]::new()
  $record = [ordered]@{name=$Label;executable=$Executable;arguments=$Arguments;startedUtc=[DateTime]::UtcNow.ToString('o');processId=$null;wallTimeMs=$null;exitCode=$null;timedOut=$false;error=$null}
  try {
    $watch.Start()
    Assert ($process.Start()) "Could not start $Label"
    $record.processId = $process.Id
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $record.timedOut = $true
      # 只停止本轮已持有句柄的进程；不按名称或 PID 搜索，不清理未知子进程。
      $process.Kill(); $null = $process.WaitForExit(10000)
      throw "Timed out: $Label. No next sample or install-directory cleanup is allowed."
    }
    $watch.Stop(); $record.wallTimeMs = $watch.ElapsedMilliseconds; $record.exitCode = $process.ExitCode
    Assert ($record.exitCode -eq 0) "$Label exited with $($record.exitCode)"
  } catch { $record.error = $_.Exception.Message; throw }
  finally {
    $watch.Stop(); if ($null -eq $record.wallTimeMs) { $record.wallTimeMs = $watch.ElapsedMilliseconds }
    $record.finishedUtc = [DateTime]::UtcNow.ToString('o')
    $invocations.Add([pscustomobject]$record); Write-Json (Join-Path $case 'invocation.json') $record
    $process.Dispose()
  }
  return [pscustomobject]$record
}
function Assert-Installed([string]$Label) {
  Assert ((Installed-Version) -ceq $ExpectedVersion) 'Actual installed ASAR version differs.'
  $registrations = @(Registrations)
  Assert ($registrations.Count -eq 1) 'Expected one uninstall registration.'
  $registration = $registrations[0]
  Assert ($registration.hive -eq 'LocalMachine' -and $registration.view -eq 'Registry64') 'Expected all-users x64 installation.'
  Assert ($registration.version -ceq $ExpectedVersion -and $registration.location.TrimEnd('\') -ieq $root) 'Installed version or location differs.'
  Assert ($registration.uninstall -ieq ('"' + $root + '\Uninstall Floatboat.exe" /allusers')) 'Unexpected uninstall command.'
  Assert (@(Get-Process -Name Floatboat -ErrorAction SilentlyContinue).Count -eq 0) 'Silent installer unexpectedly launched Floatboat.'
  $actual = @{}
  foreach ($file in Tree-Files $root) {
    $relative = $file.FullName.Substring($root.Length + 1).Replace('\','/')
    if ($relative -in @('Uninstall Floatboat.exe',[IO.Path]::GetFileName($unknownFile))) { continue }
    $actual[$relative] = $file
  }
  Assert ($actual.Count -eq @($manifest.installedFiles).Count) 'Installed payload file count differs from the shared payload.'
  foreach ($entry in $manifest.installedFiles) {
    Assert ($actual.ContainsKey($entry.path)) "Installed file missing: $($entry.path)"
    $file = $actual[$entry.path]
    Assert ($file.Length -eq $entry.bytes -and (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ieq $entry.sha256) "Installed payload differs: $($entry.path)"
  }
  foreach ($shortcut in @($desktop,$menu)) { Assert ([IO.File]::Exists($shortcut)) "Missing shortcut: $shortcut" }
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($shortcut in @($desktop,$menu)) {
      $link = $shell.CreateShortcut($shortcut)
      try { Assert ($link.TargetPath -ieq (Join-Path $root 'Floatboat.exe')) "Unexpected shortcut target: $shortcut" }
      finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
    }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  Assert ([IO.File]::ReadAllText($sentinel) -ceq $runToken) 'User data sentinel changed.'
  $mainSignature = Signature (Join-Path $root 'Floatboat.exe')
  Assert ($mainSignature.status -ceq 'Valid' -and $mainSignature.subject -ceq $signatures.B.subject) 'Installed main executable signature is not valid for this release signer.'
  $evidence = @{ label=$Label;registration=$registration;payloadDigest=$manifest.payloadDigest;verifiedFiles=$actual.Count;signatures=@($mainSignature;Signature (Join-Path $root 'Uninstall Floatboat.exe');Signature (Join-Path $root 'resources\elevate.exe')) }
  Write-Json (Join-Path $output ($Label + '-installed.json')) $evidence
}
function Reset-Installation([string]$Label) {
  $uninstaller = Join-Path $root 'Uninstall Floatboat.exe'
  $copy = Join-Path $output ($Label + '-reset-uninstaller.exe')
  Assert ([IO.File]::Exists($uninstaller)) 'Reset requires the installed uninstaller.'
  Copy-Item -LiteralPath $uninstaller -Destination $copy
  Assert ((Get-FileHash -LiteralPath $copy).Hash -ceq (Get-FileHash -LiteralPath $uninstaller).Hash) 'Reset copy differs from installed uninstaller.'
  # NSIS 官方 _?= 禁止自复制并同步返回；该复位在计时外，不充当用户普通卸载验收。
  $null = Invoke-Installer ($Label + '-reset') $copy ('/S /allusers _?=' + $root)
  Assert (@(Registrations).Count -eq 0) 'Reset left uninstall registration.'
  Assert (@(InstallLocationKeys).Count -eq 0) 'Reset left installation-location registration.'
  Assert (-not (Test-Path -LiteralPath $desktop) -and -not (Test-Path -LiteralPath $menu)) 'Reset left shortcuts.'
  Assert ([IO.File]::ReadAllText($sentinel) -ceq $runToken) 'Reset changed user data.'
  Assert-NoReparse $root
  if ([IO.Directory]::Exists($root)) {
    Assert (@([IO.Directory]::EnumerateFileSystemEntries($root)).Count -eq 0) 'Reset left installed files; no manual recursive reset is allowed.'
    [IO.Directory]::Delete($root,$false)
  }
  Assert (-not (Test-Path -LiteralPath $root)) 'Reset did not remove the installation path.'
  if ([IO.Directory]::Exists($cacheRoot)) {
    $cacheFiles = @(Tree-Files $cacheRoot | ForEach-Object { @{path=$_.FullName;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash} })
    Write-Json (Join-Path $output ($Label + '-reset-cache.json')) $cacheFiles
    # 初始检查证明本产品缓存不存在，且本轮未启动客户端；只重置此次安装生成的这个固定缓存。
    [IO.Directory]::Delete($cacheRoot,$true)
  }
  Assert (-not (Test-Path -LiteralPath $cacheRoot)) 'Reset did not remove the installer cache.'
}

Assert ($ExpectedVersion -cmatch '^\d+\.\d+\.\d+-test\.\d+$') 'Only signed test.N versions are supported.'
Assert (-not (Test-Path -LiteralPath $output)) 'Pass a new output directory.'
$workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE).TrimEnd('\')
Assert ($output.StartsWith($workspace + '\',[StringComparison]::OrdinalIgnoreCase)) 'Output must be inside this runner workspace.'
foreach ($path in @($root,$output,$userRoot,$cacheRoot)) { Assert-NoReparse $path }
Assert (-not (Test-Path -LiteralPath $root) -and @(Registrations).Count -eq 0) 'Preexisting installation found.'
Assert (@(Get-Process -Name Floatboat -ErrorAction SilentlyContinue).Count -eq 0) 'Preexisting application process found.'
foreach ($path in @($userRoot,$cacheRoot,$desktop,$menu)) { Assert (-not (Test-Path -LiteralPath $path)) "Preexisting product state: $path" }
$receipt = Get-Content -LiteralPath $BuildReceipt -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath $PayloadManifest -Raw | ConvertFrom-Json
Assert ($receipt.schemaVersion -eq 1 -and $manifest.schemaVersion -eq 1 -and $receipt.payloadUnchanged -eq $true) 'Build did not prove shared payload.'
Assert ($receipt.appGuid -cmatch '^[a-fA-F0-9-]{36}$' -and @(InstallLocationKeys).Count -eq 0) 'Preexisting install-location registration or invalid product GUID.'
Assert ($receipt.version -ceq $ExpectedVersion -and $manifest.version -ceq $ExpectedVersion -and $receipt.payloadDigest -ceq $manifest.payloadDigest) 'Build/manifest version or payload identity differs.'
$installers = @{A=[string]$receipt.baselineInstaller;B=[string]$receipt.candidateInstaller}
$signatures = @{}
foreach ($mode in @('A','B')) {
  $signatures[$mode] = Signature $installers[$mode]
  Assert ($signatures[$mode].status -ceq 'Valid') "$mode installer Authenticode must be Valid."
  $expectedHash = if ($mode -eq 'A') { $receipt.baselineSha256 } else { $receipt.candidateSha256 }
  Assert ($signatures[$mode].sha256 -ieq $expectedHash) "$mode installer bytes changed after build."
  Assert ((Get-Item -LiteralPath $installers[$mode]).VersionInfo.ProductVersion.Trim() -ceq $ExpectedVersion) "$mode signed version differs."
}
Assert ($signatures.A.subject -ceq $signatures.B.subject) 'Installer signing identity differs.'
[IO.Directory]::CreateDirectory($output) | Out-Null
[IO.Directory]::CreateDirectory($userRoot) | Out-Null
[IO.File]::WriteAllText($sentinel,$runToken,$encoding)
Write-Json (Join-Path $output 'environment.json') @{runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;runnerImage=$env:ImageVersion;os=[Environment]::OSVersion.VersionString;version=$ExpectedVersion;installers=$signatures;sourceSha=$receipt.sourceSha;baselineSourceSha=$receipt.baselineSourceSha;payloadDigest=$manifest.payloadDigest;order=@('AB','BA','AB','BA');security='OS cache and security software remain enabled.'}
try {
  for ($pair=1; $pair -le 4; $pair++) {
    $order = if ($pair % 2) { @('A','B') } else { @('B','A') }
    foreach ($mode in $order) {
      $label = 'pair-' + $pair + '-' + $mode
      $null = Invoke-Installer ($label + '-seed-A') $installers.A ('/S /D=' + $root)
      Assert-Installed ($label + '-seed-A')
      [IO.File]::WriteAllText($unknownFile,$runToken,$encoding)
      $measured = Invoke-Installer ($label + '-upgrade') $installers[$mode] ('/S /D=' + $root)
      Assert-Installed ($label + '-upgrade')
      $unknownPreserved = [IO.File]::Exists($unknownFile) -and [IO.File]::ReadAllText($unknownFile) -ceq $runToken
      if ($mode -eq 'B') { Assert $unknownPreserved 'Candidate overwrite changed unknown user content.' }
      if ([IO.File]::Exists($unknownFile)) { [IO.File]::Delete($unknownFile) }
      $samples.Add([pscustomobject]@{pair=$pair;mode=$mode;position=[Array]::IndexOf($order,$mode)+1;wallTimeMs=$measured.wallTimeMs;exitCode=$measured.exitCode;unknownUserFilePreserved=$unknownPreserved;payloadDigest=$manifest.payloadDigest})
      Reset-Installation $label
    }
  }
} catch { $failure = $_ | Out-String }
finally {
  $summary = @{}
  foreach ($mode in @('A','B')) {
    $values = @($samples | Where-Object mode -eq $mode | ForEach-Object wallTimeMs | Sort-Object)
    if ($values.Count -eq 4) { $summary[$mode] = @{samplesMs=$values;medianMs=($values[1]+$values[2])/2.0;slowestMs=$values[3]} }
  }
  $complete = -not $failure -and $samples.Count -eq 8
  $faster = $complete -and $summary.B.medianMs -lt $summary.A.medianMs
  Write-Json (Join-Path $output 'report.json') @{functionalPassed=$complete;performancePassed=$faster;failure=$failure;samples=@($samples.ToArray());summary=$summary;invocations=@($invocations.ToArray());limitations=@('同一完整应用载荷与版本，只比较 NSIS 实现；不测应用启动或真实交互停机。','/S 静默安装不启动旧进度监控器，只证明安装流水线/文件操作差异，不能替代点击安装界面的总耗时。','升级时间为提升上下文中直接启动的安装器进程结束时间；无后台后代追踪。','每臂先相同 A 首装，校验、复位、缓存清理和哈希均在计时外；缓存/防护保持启用，不能等同用户电脑。','复位使用已安装卸载器的字节副本及官方 _?= 参数，不是普通双击卸载兼容性验收。','记录内部卸载器/elevate签名实际状态；外层A/B和主程序沿用正式签名，不添加旧RC例外。')}
  if ($complete -and [IO.File]::Exists($sentinel)) { [IO.File]::Delete($sentinel); if (@([IO.Directory]::EnumerateFileSystemEntries($userRoot)).Count -eq 0) { [IO.Directory]::Delete($userRoot,$false) } }
}
if (-not $complete) { throw "Installation correctness comparison failed: $failure" }
if (-not $faster) { throw 'Eight samples passed correctness, but candidate median did not improve; see report.json.' }
Write-Output "Same-payload installation median: A=$($summary.A.medianMs) ms; B=$($summary.B.medianMs) ms."
