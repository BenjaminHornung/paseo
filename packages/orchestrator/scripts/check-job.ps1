param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'check-job.cs')
$result=[CheckJob]::Run([string[]]$data.command,[string]$data.cwd,[int]$data.timeoutMs)
Write-Output "ORCHESTRATOR_CHECK_RESULT:$result"
