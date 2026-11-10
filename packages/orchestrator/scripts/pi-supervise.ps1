param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'check-job.cs')
$code=[CheckJob]::RunAgent([string[]]$data.command,[string]$data.cwd,[string]$data.nodeExecutable,[string]$data.monitorFile,[string]$data.execBridgeExecutable)
exit $code
