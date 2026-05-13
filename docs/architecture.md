# Entra Role Sync Function — Architecture

## Overview

The application is an Azure Functions app (Node.js, Flex Consumption plan) that
synchronizes Microsoft Entra ID users assigned to a target enterprise application
role by stamping a derived value into their `onPremisesExtensionAttributes.extensionAttribute2`.
It exposes two triggers:

- **Timer trigger** — runs daily at 09:00 IST (`0 30 3 * * *` UTC).
- **HTTP trigger** — browser dashboard at `/api/role-sync` for on-demand runs
  with a dry-run preview, protected by Microsoft Entra ID via App Service
  Authentication V2.

## Component Diagram

```mermaid
flowchart LR
    subgraph User["End User"]
        Browser["Browser"]
        Scheduler["⏱ CRON 09:00 IST"]
    end

    subgraph Auth["App Service Authentication V2"]
        EasyAuth["EasyAuth Middleware"]
        DashApp["Entra App Registration<br/>(Dashboard sign-in)<br/>client: dcaf638d-...a16a"]
    end

    subgraph FunctionApp["Azure Function App<br/>entra-role-sync-mi-0423125600<br/>(Flex Consumption, Linux, Node 20)"]
        HTTPTrigger["HTTP Trigger<br/>syncDashboard.js<br/>GET/POST /api/role-sync"]
        TimerTrigger["Timer Trigger<br/>roleSyncTimer.js"]
        SyncCore["syncUsers()<br/>shared core logic"]
        Config["config.js<br/>env config"]
        GraphClient["graphClient.js<br/>retry-wrapped Graph ops"]
        MI["System-assigned<br/>Managed Identity"]
    end

    subgraph Storage["Storage Account<br/>scimsync0423181043"]
        Blob["Blob (deployment package)"]
        Queue["Queue"]
        Table["Table"]
    end

    subgraph EntraTenant["Target Microsoft Entra Tenant<br/>fc42bad7-...475e"]
        SPCred["App Registration<br/>(Sync client)<br/>ClientSecretCredential"]
        Graph["Microsoft Graph API"]
        EntApp["Target Enterprise App<br/>+ App Roles"]
        Users["Users + Groups"]
    end

    Browser -->|HTTPS| EasyAuth
    EasyAuth -->|OIDC redirect| DashApp
    DashApp -->|id_token| EasyAuth
    EasyAuth -->|authenticated| HTTPTrigger
    Scheduler --> TimerTrigger

    HTTPTrigger --> SyncCore
    TimerTrigger --> SyncCore
    SyncCore --> Config
    SyncCore --> GraphClient

    GraphClient -->|Bearer token| Graph
    SPCred -.client secret.-> GraphClient
    Graph --> EntApp
    Graph --> Users

    FunctionApp -->|host runtime| Blob
    FunctionApp --> Queue
    FunctionApp --> Table
    MI -->|Storage Blob/Queue/Table<br/>Data Contributor| Storage

    HTTPTrigger -->|HTML response<br/>impacted users table| Browser
```

## Sync Sequence (HTTP dashboard run)

```mermaid
sequenceDiagram
    autonumber
    actor U as User (Browser)
    participant EA as EasyAuth (AAD)
    participant H as syncDashboard (HTTP)
    participant S as syncUsers()
    participant G as Microsoft Graph
    U->>EA: GET /api/role-sync
    EA->>U: 302 → login.microsoftonline.com
    U->>EA: id_token (callback)
    EA->>H: GET (authenticated)
    H-->>U: HTML form (dryRun toggle)
    U->>H: POST dryRun=true|false
    H->>S: syncUsers(ctx, { dryRun })
    S->>G: GET servicePrincipal + appRoleAssignedTo
    G-->>S: assignments (users + groups)
    S->>G: GET group transitive members
    S->>G: GET user (extensionAttribute2)
    alt dryRun = false AND change needed
        S->>G: PATCH user.onPremisesExtensionAttributes
    end
    S-->>H: { impactedUsers[], counts, dryRun }
    H-->>U: HTML results table (current → new)
```

## Timer Sequence (daily 09:00 IST)

```mermaid
sequenceDiagram
    autonumber
    participant T as Timer (CRON)
    participant S as syncUsers()
    participant G as Microsoft Graph
    T->>S: fire (dryRun = config default)
    S->>G: enumerate role assignments
    S->>G: expand groups → users
    loop per user in target role
        S->>G: GET user
        alt extensionAttribute2 differs
            S->>G: PATCH user
        end
    end
    S-->>T: log summary (scoped, updated, skipped)
```

## Key Configuration

| Setting | Purpose |
| --- | --- |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | Sync client credential into target tenant |
| `TARGET_SERVICE_PRINCIPAL_ID` / `TARGET_APPLICATION_ID` | Enterprise app whose role assignments are scanned |
| `TARGET_APP_ROLE_VALUE` / `TARGET_APP_ROLE_DISPLAY_NAME` | App role to filter users by |
| `TIMER_SCHEDULE` | NCRONTAB schedule (default `0 30 3 * * *`) |
| `DRY_RUN` | Default mode for timer trigger |
| `MAX_GRAPH_RETRIES` | Backoff retry count for 429/503/504 |
| `AzureWebJobsStorage` | Function host storage (managed identity) |

## Required Graph Permissions (Sync client app)

- `Application.Read.All` — read service principal & app role definitions
- `User.Read.All` — read user objects (incl. `onPremisesExtensionAttributes`)
- `User.ReadWrite.All` — patch `extensionAttribute2`
- `GroupMember.Read.All` — expand transitive group memberships

## Dashboard Sign-in App Permissions

- Microsoft Graph delegated: `User.Read`, `openid`, `profile`, `email`
  (admin-consented tenant-wide).
