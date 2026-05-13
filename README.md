# Entra Role Sync Function

A Node.js Azure Functions app that keeps Microsoft Entra ID users in sync with a
target enterprise application role by stamping a derived value into
`onPremisesExtensionAttributes.extensionAttribute2`. That attribute is then
consumed by downstream SCIM provisioning (for example, the GitHub EMU SCIM
connector) to route users to the right downstream identity.

## What the application does

- **Timer trigger** (`src/roleSyncTimer.js`) runs on an NCRONTAB schedule
  (default `0 30 3 * * *` UTC = 09:00 IST) and reconciles `extensionAttribute2`
  for every user assigned (directly or via group) to the target app role.
- **HTTP trigger** (`src/syncDashboard.js`) exposes a small browser dashboard at
  `GET/POST /api/role-sync` for on-demand runs with a dry-run preview. It is
  protected by App Service Authentication V2 (EasyAuth / Microsoft Entra ID).
- **Shared core** (`syncUsers()`) talks to Microsoft Graph through a
  retry-wrapped client (`src/graphClient.js`) using a `ClientSecretCredential`
  for the sync app registration in the target tenant.

See [`docs/architecture.md`](docs/architecture.md) for component, sequence, and
configuration diagrams.

## Repository layout

```
host.json                     # Functions host configuration
package.json                  # Dependencies and scripts
local.settings.json.example   # Template for local app settings
src/
  app.js                      # Entry point – registers both triggers
  config.js                   # Reads + validates environment settings
  graphClient.js              # Microsoft Graph client with retry/backoff
  roleSyncTimer.js            # Timer trigger registration
  syncDashboard.js            # HTTP trigger + HTML dashboard
docs/architecture.md          # Architecture and sequence diagrams
```

## Prerequisites

- Node.js 20+ and npm
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`)
- An Azure subscription with permission to create Function Apps and Storage
  accounts
- Microsoft Entra ID tenant admin (or delegated) rights to:
  - Create an **app registration** for Graph access (client secret) with
    `Application.Read.All`, `User.Read.All`, `User.ReadWrite.All`, and
    `GroupMember.Read.All` application permissions (admin-consented)
  - Create a second **app registration** for the dashboard EasyAuth sign-in
    (delegated `User.Read`, `openid`, `profile`, `email`)
  - Identify the target enterprise application's service principal id,
    application id, and the specific app role to filter on

## Local development

1. `npm install`
2. Copy the settings template and fill in the placeholders:
   ```bash
   cp local.settings.json.example local.settings.json
   ```
   Set `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`,
   `TARGET_SERVICE_PRINCIPAL_ID`, `TARGET_APPLICATION_ID`,
   `TARGET_ENTERPRISE_APP_NAME`, `TARGET_APP_ROLE_VALUE`, and
   `TARGET_APP_ROLE_DISPLAY_NAME`. Either keep
   `AzureWebJobsStorage=UseDevelopmentStorage=true` and run Azurite, or point at
   a real storage account.
3. `npm start` (wraps `func start`). The dashboard will be available at
   <http://localhost:7071/api/role-sync> and the timer will fire per the
   configured schedule.
4. `npm run test:syntax` performs a quick `node --check` of every source file.

> Note: `local.settings.json` is gitignored — never commit real secrets.

## Deploying to Azure

The steps below provision the supporting infrastructure and then deploy the
function code. Replace the placeholder values to suit your environment.

### 1. Set shell variables

```bash
RG=entra-role-sync-rg
LOCATION=eastus
STORAGE=scimsync$RANDOM
PLAN=entra-role-sync-plan
APP=entra-role-sync-$RANDOM
SUBSCRIPTION=<your-subscription-id>

az account set --subscription "$SUBSCRIPTION"
```

### 2. Create the resource group and storage account

```bash
az group create --name "$RG" --location "$LOCATION"

az storage account create \
  --name "$STORAGE" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --allow-blob-public-access false
```

### 3. Create the Function App (Flex Consumption, Node 20, Linux)

```bash
az functionapp create \
  --resource-group "$RG" \
  --name "$APP" \
  --storage-account "$STORAGE" \
  --flexconsumption-location "$LOCATION" \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --assign-identity '[system]'
```

> A Consumption (`--consumption-plan-location`) or Premium plan also works if
> Flex Consumption is unavailable in your region; the code itself is plan
> agnostic.

### 4. Grant the Function App identity access to its storage account

Allow the Function App's system-assigned managed identity to read/write the
host storage (required when using identity-based `AzureWebJobsStorage`):

```bash
PRINCIPAL_ID=$(az functionapp identity show -g "$RG" -n "$APP" --query principalId -o tsv)
STORAGE_ID=$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)

for ROLE in "Storage Blob Data Owner" "Storage Queue Data Contributor" "Storage Table Data Contributor"; do
  az role assignment create --assignee "$PRINCIPAL_ID" --role "$ROLE" --scope "$STORAGE_ID"
done
```

### 5. Configure application settings

Set every value the function expects at runtime (mirrors
`local.settings.json.example`):

```bash
az functionapp config appsettings set -g "$RG" -n "$APP" --settings \
  FUNCTIONS_WORKER_RUNTIME=node \
  TIMER_SCHEDULE="0 30 3 * * *" \
  GRAPH_TENANT_ID="<tenant-id>" \
  GRAPH_CLIENT_ID="<sync-app-client-id>" \
  GRAPH_CLIENT_SECRET="<sync-app-client-secret>" \
  TARGET_SERVICE_PRINCIPAL_ID="<service-principal-id>" \
  TARGET_APPLICATION_ID="<application-id>" \
  TARGET_ENTERPRISE_APP_NAME="<enterprise-app-display-name>" \
  TARGET_APP_ROLE_VALUE="<app-role-value>" \
  TARGET_APP_ROLE_DISPLAY_NAME="<app-role-display-name>" \
  MAX_GRAPH_RETRIES=4 \
  DRY_RUN=false \
  AzureWebJobsStorage__accountName="$STORAGE" \
  AzureWebJobsStorage__credential=managedidentity
```

Prefer Key Vault references for `GRAPH_CLIENT_SECRET` in production
(`@Microsoft.KeyVault(SecretUri=...)`).

### 6. Enable App Service Authentication V2 for the dashboard

Protect the HTTP trigger with Microsoft Entra ID so only authorised users can
launch on-demand syncs:

1. In the Azure portal, open the Function App → **Authentication** → **Add
   identity provider** → **Microsoft**.
2. Create a new app registration (or reuse one) and require authentication for
   unauthenticated requests (Token store enabled, "Require authentication"
   redirect to provider).
3. Grant the dashboard app delegated `User.Read`, `openid`, `profile`, `email`
   and admin-consent tenant-wide.

### 7. Deploy the function code

From the repo root, install production dependencies and publish with the
Functions Core Tools:

```bash
npm install --omit=dev
func azure functionapp publish "$APP" --javascript
```

Alternatives:

- **Zip deploy:** `az functionapp deployment source config-zip -g "$RG" -n "$APP" --src project.zip`
- **GitHub Actions:** use the `Azure/functions-action@v1` task with a publish
  profile or OIDC credentials.

### 8. Verify the deployment

```bash
# Confirm both functions are registered with the host
az functionapp function list -g "$RG" -n "$APP" -o table

# Tail live logs
az functionapp log tail -g "$RG" -n "$APP"
```

Open `https://<APP>.azurewebsites.net/api/role-sync`, sign in, and run a
**dry-run** to confirm the dashboard reports the expected impacted users. The
timer will then fire automatically on the configured schedule.

## Configuration reference

| Setting | Purpose |
| --- | --- |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | Credential for the sync app registration in the target tenant |
| `TARGET_SERVICE_PRINCIPAL_ID` / `TARGET_APPLICATION_ID` | Enterprise app whose role assignments are scanned |
| `TARGET_ENTERPRISE_APP_NAME` | Display name shown in logs/dashboard |
| `TARGET_APP_ROLE_VALUE` / `TARGET_APP_ROLE_DISPLAY_NAME` | App role used to filter users |
| `TIMER_SCHEDULE` | NCRONTAB schedule for the timer trigger (UTC) |
| `DRY_RUN` | Default mode for the timer trigger (`true` skips PATCHes) |
| `MAX_GRAPH_RETRIES` | Backoff retry count for Graph 429/503/504 |
| `AzureWebJobsStorage*` | Function host storage (connection string or managed identity) |

## Troubleshooting

- **Missing required setting** error at startup → an app setting from the table
  above is empty.
- **401/403 from Graph** → the sync app registration is missing admin consent
  for the required application permissions.
- **Timer not firing** → check that `AzureWebJobsStorage` is reachable and that
  `FUNCTIONS_WORKER_RUNTIME=node` is set.
- **Dashboard returns HTTP 401** → EasyAuth is enabled but the signed-in user
  lacks access; assign them to the dashboard app or its allow-list.
