$ErrorActionPreference = 'Stop'
try {
  $temporaryRoot = $env:TMP
  if ([string]::IsNullOrEmpty($temporaryRoot) -or $temporaryRoot -ne $env:TEMP) {
    throw 'The child must inherit matching TMP and TEMP.'
  }
  if ($temporaryRoot -notmatch '^.+\\Temp\\fb[0-9a-fA-F]{8}$') {
    throw "Unexpected private temporary root: $temporaryRoot"
  }
  $acl = Get-Acl -LiteralPath $temporaryRoot
  if (-not $acl.AreAccessRulesProtected) { throw 'The directory DACL is not protected.' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $sids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  if ($sids.Count -ne 2 -or $sids -notcontains 'S-1-5-18' -or $sids -notcontains 'S-1-5-32-544') {
    throw "Unexpected ACL identities: $($sids -join ', ')"
  }
  foreach ($rule in $rules) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
        ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) {
      throw 'The ACL must explicitly allow full control only to SYSTEM and Administrators.'
    }
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    if (($rule.InheritanceFlags -band $inheritance) -ne $inheritance) {
      throw 'The protected permissions must apply to child files and directories.'
    }
  }
  [ordered]@{
    status = 'passed'; tmp = $env:TMP; temp = $env:TEMP
    protected = $acl.AreAccessRulesProtected; sddl = $acl.Sddl
    pointerSize = [IntPtr]::Size
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $env:FLOATBOAT_TEMP_FIXTURE_OUTPUT 'child.json') -Encoding UTF8
  exit 0
} catch {
  [ordered]@{ status = 'failed'; error = $_.Exception.Message } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $env:FLOATBOAT_TEMP_FIXTURE_OUTPUT 'child.json') -Encoding UTF8
  exit 1
}
