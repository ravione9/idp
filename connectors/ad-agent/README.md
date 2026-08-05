# LILG Active Directory Connector Agent

On-prem Windows agent for **bidirectional** directory sync between **Microsoft Active Directory** and the LILG Identity Provider.

- Agent connects **outbound** to the IdP over **HTTPS port 443** (no inbound firewall rules on the IdP for LDAP).
- **AD credentials stay on this server** in `config.json` — they are never sent to the cloud IdP.
- Syncs users **inbound** (AD → IdP) and provisions/disables **outbound** (IdP → AD).
- Mirrors AD security groups into **Identity → Groups** when **Sync Groups** is configured on the connector.

**Agent version:** 1.1.0

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| OS | Windows Server 2016+ or Windows 10/11 (domain-joined recommended) |
| Network | Outbound HTTPS `:443` to your IdP hostname; LDAP/LDAPS to domain controller(s) |
| AD account | Service account with read (inbound) + create/disable user (outbound) permissions |
| IdP setup | **Active Directory (Agent)** connector created in **Admin → Directory Sync** |

---

## 1. Register the connector in the IdP admin console

1. Open **Admin → Connections → Directory Sync** (Universal Directory).
2. Click **+ Add Source** → choose **Active Directory (Agent)**.
3. Set **IdP URL** (e.g. `https://idp.example.com`).
4. Set **Base DN**, **New User OU**, **UPN suffix**, and **Sync Groups** (optional).
5. Save and **copy the one-time agent token** and **connector ID** — you cannot retrieve the token later.

---

## 2. Configure the agent

1. Extract this ZIP to a folder, e.g. `C:\LILG\ad-connector`.
2. Copy `config.example.json` to `config.json` in the same folder.
3. Edit `config.json`:

```json
{
  "idpUrl": "https://idp.example.com",
  "connectorId": "paste-uuid-from-admin-console",
  "agentToken": "paste-token-shown-once-at-creation",
  "pollIntervalSeconds": 30,
  "heartbeatIntervalSeconds": 60,
  "ad": {
    "host": "dc01.corp.example.com",
    "port": 636,
    "useSsl": true,
    "startTls": false,
    "bindDn": "CN=svc-lilg,OU=Service Accounts,DC=corp,DC=example,DC=com",
    "bindPassword": "your-service-account-password",
    "baseDn": "DC=corp,DC=example,DC=com",
    "targetOu": "OU=Employees",
    "upnDomain": "corp.example.com",
    "disabledOu": "OU=Disabled,"
  }
}
```

| Field | Description |
|-------|-------------|
| `idpUrl` | IdP public URL (HTTPS, port 443) |
| `connectorId` | UUID from connector creation |
| `agentToken` | One-time token from connector creation |
| `ad.host` | Domain controller hostname or IP |
| `ad.port` | `636` for LDAPS, `389` for LDAP/StartTLS |
| `ad.useSsl` | `true` for LDAPS (recommended for provisioning) |
| `ad.startTls` | `true` to use StartTLS on port 389 |
| `ad.bindDn` / `bindPassword` | AD service account |
| `ad.baseDn` | Domain root or OU to search users |
| `ad.targetOu` | OU for new user provisioning (outbound) |

---

## 3. Run the agent

### Option A — Pre-built JavaScript (included `dist/` folder)

Requires **Node.js 22+** on the server:

```powershell
cd C:\LILG\ad-connector
node dist\index.js
```

### Option B — Build from source

```powershell
cd C:\LILG\ad-connector
npm install
npm run build
node dist/index.js
```

### Option C — Standalone EXE (optional)

On a build machine with Node.js:

```powershell
npm install
npm run package:win
# Produces dist\lilg-ad-connector.exe — copy exe + config.json to the server
.\dist\lilg-ad-connector.exe
```

---

## 4. Install as a Windows service (recommended)

Run **PowerShell as Administrator** from the install folder.

### Scheduled task (no extra tools)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-task.ps1 -InstallDir "C:\LILG\ad-connector"
Start-ScheduledTask -TaskName 'LILG-AD-Connector'
```

### True Windows Service (requires NSSM)

Download [NSSM](https://nssm.cc/download), then:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service-nssm.ps1 `
  -InstallDir "C:\LILG\ad-connector" `
  -NssmPath "C:\Tools\nssm.exe"
```

Logs (NSSM): `C:\LILG\ad-connector\logs\`

### Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

---

## 5. Verify in the admin console

1. Within ~5 minutes the agent sends a **heartbeat** with AD connectivity status.
2. Click **Test Connection** on the connector — status should become **Connected**.
3. Click **Sync** to queue a job; the agent picks it up on the next poll (default 30s).
4. Check **History** for run results; users appear under **Directory Sync → Users**.

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Connector stays “Waiting for agent” | Agent running? `idpUrl` reachable on 443? Token/connector ID correct? |
| Heartbeat OK but sync fails | AD bind DN/password; Base DN; firewall to DC on 389/636 |
| Outbound provision fails | Use LDAPS or StartTLS; target OU must exist in AD |
| Groups empty | Run user sync first; configure **Sync Groups** on connector |
| `403 Invalid agent token` | Regenerate connector (delete + recreate) or fix `agentToken` in config |

Agent logs are JSON lines written to stdout — capture via Task Scheduler history or NSSM log files.

---

## Package contents

```
lilg-ad-connector/
  README.md                 ← this file
  config.example.json       ← copy to config.json
  package.json
  tsconfig.json
  dist/                     ← compiled agent (node dist/index.js)
  src/                      ← TypeScript source
  scripts/
    install-scheduled-task.ps1
    install-service-nssm.ps1
    uninstall.ps1
```

---

## Security notes

- Restrict filesystem ACLs on `config.json` (contains AD password and agent token).
- Use a dedicated AD service account with least privilege.
- Agent only initiates **outbound** HTTPS; no inbound ports required on the agent host.
- Rotate the agent token by recreating the connector if compromised.
