param([ValidatePattern('^(?:[a-f0-9]{32})?$')][string]$Generation='')
$ErrorActionPreference='Stop'
try {
  if(-not $env:PASEO_ORCHESTRATOR_DATA_ROOT -or
    -not [IO.Path]::IsPathFullyQualified($env:PASEO_ORCHESTRATOR_DATA_ROOT)){throw 'data root'}
  $name=if($Generation){"normal-$Generation.dpapi"}else{'normal.dpapi'}
  $file=Join-Path $env:PASEO_ORCHESTRATOR_DATA_ROOT "state/secrets/$name"
  $secure=ConvertTo-SecureString -String ([IO.File]::ReadAllText($file).Trim())
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))}
  finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
} catch {[Console]::Error.Write('Credential unavailable'); exit 1}
