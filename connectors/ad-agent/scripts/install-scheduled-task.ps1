#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install LILG AD Connector as a Windows Scheduled Task (runs at startup, no extra tools).

.PARAMETER InstallDir
  Folder containing lilg-ad-connector.exe (or node dist\index.js) and config.json.

.PARAMETER TaskName
  Scheduled task name (default: LILG-AD-Connector).

.EXAMPLE
  .\install-scheduled-task.ps1 -InstallDir "C:\LILG\ad-connector"
#>
param(
  [Parameter(Mandatory = $true)]
  [string] $InstallDir,

  [string] $TaskName = 'LILG-AD-Connector'
)

$ErrorActionPreference = 'Stop'
$InstallDir = (Resolve-Path $InstallDir).Path

function Get-CommandPath([string] $Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$exe = Join-Path $InstallDir 'lilg-ad-connector.exe'
$nodeScript = Join-Path $InstallDir 'dist\index.js'
$config = Join-Path $InstallDir 'config.json'

if (-not (Test-Path $config)) {
  throw "config.json not found in $InstallDir - copy config.example.json and edit AD + IdP settings."
}

if (Test-Path $exe) {
  $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $InstallDir
} elseif (Test-Path $nodeScript) {
  $node = Get-CommandPath 'node'
  if (-not $node) { throw 'Node.js not found in PATH. Install Node 22+ or build lilg-ad-connector.exe.' }
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$nodeScript`"" -WorkingDirectory $InstallDir
} else {
  throw "Neither lilg-ad-connector.exe nor dist\index.js found in $InstallDir. Run npm run build first."
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'LILG Active Directory connector agent (HTTPS :443 to IdP)'

Write-Host "Registered scheduled task '$TaskName' - starts at boot."
Write-Host "  Start now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Stop:       Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Remove:     Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
