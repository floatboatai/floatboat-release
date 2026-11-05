# ABOUTME: 在 Windows 中比较快捷方式写入接口，保留路径字符、COM 返回值和回读证据。
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [ValidateSet('default', 'modern')][string]$PathMode = 'modern'
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
if ($PathMode -eq 'modern') {
  [AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
  [AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
}
$root = [IO.Path]::GetFullPath($OutputDirectory)
if ([IO.Directory]::Exists($root)) { throw 'Use a new probe output directory.' }
[IO.Directory]::CreateDirectory($root) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$observations = New-Object 'Collections.Generic.List[object]'
$links = New-Object 'Collections.Generic.List[string]'
$runId = [Guid]::NewGuid().ToString('N')
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class ProbeShellLink { }
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IProbeShellLinkW {
  [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr data, uint flags);
  [PreserveSig] int GetIDList(out IntPtr list);
  [PreserveSig] int SetIDList(IntPtr list);
  [PreserveSig] int GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int capacity);
  [PreserveSig] int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
  [PreserveSig] int GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int capacity);
  [PreserveSig] int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
  [PreserveSig] int GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int capacity);
  [PreserveSig] int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
  [PreserveSig] int GetHotkey(out short value);
  [PreserveSig] int SetHotkey(short value);
  [PreserveSig] int GetShowCmd(out int value);
  [PreserveSig] int SetShowCmd(int value);
  [PreserveSig] int GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int capacity, out int index);
  [PreserveSig] int SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
  [PreserveSig] int SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
  [PreserveSig] int Resolve(IntPtr window, uint flags);
  [PreserveSig] int SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
}
public static class ShortcutProbeNative {
  public static int Write(string link, string target) {
    object instance = new ProbeShellLink();
    try {
      int result = ((IProbeShellLinkW)instance).SetPath(target);
      if (result < 0) return result;
      ((IPersistFile)instance).Save(link, true);
      return result;
    } finally { Marshal.FinalReleaseComObject(instance); }
  }
}
'@
$executable = Join-Path $root 'probe.exe'
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
try {
  $parameters = New-Object CodeDom.Compiler.CompilerParameters
  $parameters.GenerateExecutable = $true
  $parameters.OutputAssembly = $executable
  $parameters.CompilerOptions = '/platform:x64'
  $compiled = $provider.CompileAssemblyFromSource($parameters, 'public class ProbeApp { public static void Main() {} }')
  if ($compiled.Errors.HasErrors) { throw ($compiled.Errors | Out-String) }
} finally { $provider.Dispose() }
$targets = New-Object 'Collections.Generic.List[object]'
foreach ($shape in @(@{ name = 'ascii'; relative = 'ascii' }, @{ name = 'unicode'; relative = '程序 Floatboat' }, @{ name = 'failure-shape'; relative = 'windows-installer-upgrade-temp\transaction\registration-and-shortcut-commit-gate\程序 Floatboat' })) {
  $directory = Join-Path $root $shape.relative
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $target = [IO.Path]::Combine($directory, 'Floatboat.exe')
  [IO.File]::Copy($executable, $target)
  $targets.Add(@{ name = $shape.name; path = $target })
}
$targets.Add(@{ name = 'system-notepad'; path = [IO.Path]::Combine($env:WINDIR, 'System32\notepad.exe') })
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
$sequence = 0
try {
  foreach ($switches in @(($PathMode -eq 'modern'))) {
    foreach ($target in $targets) {
      foreach ($extended in @($false, $true)) {
        [string]$path = if ($extended) { '\\?\' + $target.path } else { $target.path }
        foreach ($api in @('wsh-direct', 'wsh-adapter', 'wsh-reflection', 'shell-link-w')) {
          $sequence++
          $link = Join-Path $desktop "Floatboat shortcut probe $runId-$sequence.lnk"
          $links.Add($link)
          $record = [ordered]@{ shape = $target.name; modernPathSwitches = $switches; extended = $extended; api = $api; target = $path; targetLength = $path.Length; targetType = $path.GetType().FullName; targetExists = [IO.File]::Exists($path); targetCodePoints = @($path.ToCharArray() | ForEach-Object { [int]$_ }); shortcut = $link; shortcutLength = $link.Length; status = 'failed'; stage = 'create'; comType = ''; result = $null; readback = ''; errors = @() }
          $shell = $null
          $shortcut = $null
          try {
            if ($api -eq 'shell-link-w') {
              $record.stage = 'native-write'
              $record.result = [ShortcutProbeNative]::Write($link, $path)
              if ($record.result -lt 0) { [Runtime.InteropServices.Marshal]::ThrowExceptionForHR($record.result) }
            } else {
              $shell = New-Object -ComObject WScript.Shell
              $shortcut = $shell.CreateShortcut($link)
              $record.comType = $shortcut.GetType().FullName
              $record.stage = 'set-target'
              switch ($api) {
                'wsh-direct' { $shortcut.TargetPath = $path }
                'wsh-adapter' { $shortcut.psobject.properties['TargetPath'].Value = $path }
                'wsh-reflection' { $shortcut.GetType().InvokeMember('TargetPath', [Reflection.BindingFlags]::SetProperty, $null, $shortcut, @([string]$path)) | Out-Null }
              }
              $record.stage = 'save'
              $shortcut.Save()
              [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
              $shortcut = $null
            }
            $record.stage = 'readback'
            if ($null -eq $shell) { $shell = New-Object -ComObject WScript.Shell }
            $shortcut = $shell.CreateShortcut($link)
            $record.readback = [string]$shortcut.TargetPath
            if (-not [IO.File]::Exists($link)) { throw 'The shortcut was not saved.' }
            $record.status = 'passed'
          } catch {
            $exception = $_.Exception
            while ($null -ne $exception) {
              $record.errors += @{ type = $exception.GetType().FullName; message = $exception.Message; hresult = $exception.HResult; hexHresult = $exception.HResult.ToString('X8') }
              $exception = $exception.InnerException
            }
          } finally {
            if ($null -ne $shortcut) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
            if ($null -ne $shell) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
          }
          $observations.Add([PSCustomObject]$record)
        }
      }
    }
  }
} finally {
  [IO.File]::WriteAllText((Join-Path $root 'observations.json'), (@{ powershell = $PSVersionTable.PSVersion.ToString(); platform = [Environment]::OSVersion.ToString(); currentDirectory = [Environment]::CurrentDirectory; culture = [Globalization.CultureInfo]::CurrentCulture.Name; observations = $observations.ToArray() } | ConvertTo-Json -Depth 12), $utf8)
  foreach ($link in $links) { [IO.File]::Delete($link) }
}
$observations | Group-Object api,modernPathSwitches,extended,status | Select-Object Name,Count | Format-Table -AutoSize
