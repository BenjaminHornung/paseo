$ErrorActionPreference='Stop'
try {
  if(-not $env:PASEO_ORCHESTRATOR_DATA_ROOT -or
    -not [IO.Path]::IsPathFullyQualified($env:PASEO_ORCHESTRATOR_DATA_ROOT) -or
    (Get-Location).Path -ine [IO.Path]::GetFullPath($env:PASEO_ORCHESTRATOR_DATA_ROOT)){throw 'cwd'}
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if($request.operation -eq 'protect') {
    $secure=ConvertTo-SecureString -String $request.value -AsPlainText -Force
    [Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))
  } elseif($request.operation -eq 'unprotect') {
    $secure=ConvertTo-SecureString -String $request.value
    $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))}
    finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
  } else {throw 'operation'}
} catch {[Console]::Error.Write('Credential operation failed'); exit 1}
