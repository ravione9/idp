#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Uninstall LILG AD Connector scheduled task or NSSM service.

.PARAMETER TaskName
  Scheduled task name (default: LILG-AD-Connector).

.PARAMETER ServiceName
  Windows service name if installed via NSSM (default: LILG-AD-Connector).
#>
param(
  [string] $TaskName = 'LILG-AD-Connector',
  [string] $ServiceName = 'LILG-AD-Connector'
)

$ErrorActionPreference = 'SilentlyContinue'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue)?.Source
  if ($nssm) {
    & $nssm stop $ServiceName
    & $nssm remove $ServiceName confirm
    Write-Host "Removed NSSM service '$ServiceName'."
  } else {
    Write-Warning "Service '$ServiceName' exists but nssm not in PATH — remove manually via services.msc"
  }
}

if (-not $task -and -not $svc) {
  Write-Host "Nothing to remove (task and service not found)."
}
