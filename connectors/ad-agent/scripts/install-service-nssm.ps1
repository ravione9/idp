#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install LILG AD Connector as a true Windows Service via NSSM (Non-Sucking Service Manager).

.PARAMETER InstallDir
  Folder containing lilg-ad-connector.exe and config.json.

.PARAMETER ServiceName
  Windows service name (default: LILG-AD-Connector).

.PARAMETER NssmPath
  Path to nssm.exe. Download from https://nssm.cc/download if not installed.

.EXAMPLE
  .\install-service-nssm.ps1 -InstallDir "C:\LILG\ad-connector" -NssmPath "C:\Tools\nssm\nssm.exe"
#>
param(
  [Parameter(Mandatory = $true)]
  [string] $InstallDir,

  [string] $ServiceName = 'LILG-AD-Connector',

  [string] $NssmPath = ''
)

$ErrorActionPreference = 'Stop'
$InstallDir = (Resolve-Path $InstallDir).Path

function Get-CommandPath([string] $Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

if (-not $NssmPath) {
  $NssmPath = Get-CommandPath 'nssm'
}
if (-not $NssmPath -or -not (Test-Path $NssmPath)) {
  throw @"
NSSM not found. Download from https://nssm.cc/download (win64\nssm.exe).
Then re-run:
  .\install-service-nssm.ps1 -InstallDir '$InstallDir' -NssmPath 'C:\path\to\nssm.exe'
"@
}

$exe = Join-Path $InstallDir 'lilg-ad-connector.exe'
$nodeScript = Join-Path $InstallDir 'dist\index.js'
$config = Join-Path $InstallDir 'config.json'

if (-not (Test-Path $config)) {
  throw "config.json not found in $InstallDir"
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  & $NssmPath stop $ServiceName 2>$null
  & $NssmPath remove $ServiceName confirm 2>$null
  Start-Sleep -Seconds 2
}

if (Test-Path $exe) {
  & $NssmPath install $ServiceName $exe
} elseif (Test-Path $nodeScript) {
  $node = Get-CommandPath 'node'
  if (-not $node) { throw 'Node.js not in PATH' }
  & $NssmPath install $ServiceName $node "`"$nodeScript`""
} else {
  throw "Build lilg-ad-connector.exe or dist\index.js in $InstallDir first."
}

& $NssmPath set $ServiceName AppDirectory $InstallDir
& $NssmPath set $ServiceName DisplayName 'LILG Active Directory Connector'
& $NssmPath set $ServiceName Description 'On-prem AD agent - bidirectional sync with LILG IdP over HTTPS :443'
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName AppStdout (Join-Path $InstallDir 'logs\stdout.log')
& $NssmPath set $ServiceName AppStderr (Join-Path $InstallDir 'logs\stderr.log')
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateBytes 10485760

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null

& $NssmPath start $ServiceName

Write-Host "Service '$ServiceName' installed and started."
Write-Host "  Status:  Get-Service $ServiceName"
Write-Host "  Logs:    $InstallDir\logs\"
Write-Host "  Remove:  nssm remove $ServiceName confirm"
