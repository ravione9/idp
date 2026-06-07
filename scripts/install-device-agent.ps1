#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs the Lenskart IdP device-context agent as a Windows Scheduled Task.

.DESCRIPTION
    The agent runs at user logon on http://127.0.0.1:17891/device-context
    and serves the workstation hostname, LAN IP, and MAC to the IdP login page.
    This enables session attribution (which machine was used to log in).

.PARAMETER NodePath
    Full path to node.exe. Auto-detected if Node.js is on PATH.

.PARAMETER RepoRoot
    Path to the idp repo. Defaults to the directory two levels above this script.

.EXAMPLE
    # From an elevated PowerShell session on the workstation:
    powershell -ExecutionPolicy Bypass -File "\\server\share\install-device-agent.ps1"
#>
param(
    [string]$NodePath = '',
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

# ── Locate node.exe ─────────────────────────────────────────────────────────
if (-not $NodePath) {
    $NodePath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
    if (-not $NodePath) {
        Write-Error "Node.js not found on PATH. Install Node.js 18+ or pass -NodePath 'C:\Program Files\nodejs\node.exe'"
        exit 1
    }
}
Write-Host "Using node: $NodePath"

# ── Locate agent script ─────────────────────────────────────────────────────
if (-not $RepoRoot) {
    $RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    # If run from scripts\ folder directly
    if (-not (Test-Path (Join-Path $RepoRoot 'scripts\device-context-agent.mjs'))) {
        $RepoRoot = Split-Path $PSScriptRoot -Parent
    }
}
$AgentScript = Join-Path $RepoRoot 'scripts\device-context-agent.mjs'
if (-not (Test-Path $AgentScript)) {
    Write-Error "Agent script not found at: $AgentScript"
    exit 1
}
Write-Host "Agent script: $AgentScript"

# ── Register Scheduled Task ──────────────────────────────────────────────────
$TaskName    = 'LenskartIdP-DeviceContextAgent'
$Description = 'Serves workstation hostname/IP/MAC to the Lenskart IdP login page for session attribution.'

# Remove old task if it exists
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$Action  = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$AgentScript`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -Hidden

# Run as the current logged-on user
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Settings $Settings `
    -Principal $Principal -Description $Description

Register-ScheduledTask -TaskName $TaskName -InputObject $Task | Out-Null

Write-Host ""
Write-Host "✓ Scheduled task '$TaskName' registered." -ForegroundColor Green
Write-Host "  It will start automatically at next logon."
Write-Host ""
Write-Host "Starting agent now for this session..."
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 2

# ── Verify agent is responding ───────────────────────────────────────────────
try {
    $Response = Invoke-RestMethod -Uri 'http://127.0.0.1:17891/device-context' -TimeoutSec 5
    Write-Host "✓ Agent running. Response:" -ForegroundColor Green
    Write-Host "  Hostname  : $($Response.hostname)"
    Write-Host "  Local IP  : $($Response.localIp)"
    Write-Host "  MAC       : $($Response.macAddress)"
} catch {
    Write-Warning "Agent did not respond yet. Check task status with:"
    Write-Warning "  Get-ScheduledTask -TaskName '$TaskName'"
    Write-Warning "  Start-ScheduledTask -TaskName '$TaskName'"
}
