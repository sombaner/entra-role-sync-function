require("isomorphic-fetch");

const { DefaultAzureCredential, ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");

function createCredential(config) {
  if (config.tenantId && config.clientId && config.clientSecret) {
    return new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
  }

  return new DefaultAzureCredential();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGraphClient(config) {
  const credential = createCredential(config);

  return Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const token = await credential.getToken("https://graph.microsoft.com/.default");
        return token.token;
      }
    }
  });
}

async function executeWithRetry(operation, maxRetries, logger, description) {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const status = error.statusCode || error.code || "unknown";
      const retryable = error.statusCode === 429 || error.statusCode === 503 || error.statusCode === 504;

      if (!retryable || attempt > maxRetries) {
        logger.error(`Graph request failed for ${description}`, { status, attempt, message: error.message });
        throw error;
      }

      const delayMs = attempt * 1000;
      logger.warn(`Retrying Graph request for ${description}`, { status, attempt, delayMs });
      await sleep(delayMs);
    }
  }
}

async function listAll(client, path, maxRetries, logger, description) {
  let nextLink = path;
  const results = [];

  while (nextLink) {
    const response = await executeWithRetry(
      async () => {
        if (nextLink.startsWith("https://")) {
          return client.api(nextLink).get();
        }

        return client.api(nextLink).get();
      },
      maxRetries,
      logger,
      description
    );

    if (Array.isArray(response.value)) {
      results.push(...response.value);
    }

    nextLink = response["@odata.nextLink"] || null;
  }

  return results;
}

async function getServicePrincipal(client, servicePrincipalId, maxRetries, logger) {
  return executeWithRetry(
    () => client.api(`/servicePrincipals/${servicePrincipalId}?$select=id,appId,displayName,appRoles`).get(),
    maxRetries,
    logger,
    `service principal ${servicePrincipalId}`
  );
}

async function getAppAssignments(client, servicePrincipalId, maxRetries, logger) {
  return listAll(
    client,
    `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo?$select=id,appRoleId,principalId,principalDisplayName,principalType,resourceId`,
    maxRetries,
    logger,
    `app role assignments for service principal ${servicePrincipalId}`
  );
}

async function getTransitiveGroupUsers(client, groupId, maxRetries, logger) {
  return listAll(
    client,
    `/groups/${groupId}/transitiveMembers/microsoft.graph.user?$select=id,userPrincipalName,mailNickname,onPremisesExtensionAttributes`,
    maxRetries,
    logger,
    `transitive user members for group ${groupId}`
  );
}

async function getUser(client, userId, maxRetries, logger) {
  return executeWithRetry(
    () => client.api(`/users/${userId}?$select=id,userPrincipalName,mailNickname,onPremisesExtensionAttributes,userType`).get(),
    maxRetries,
    logger,
    `user ${userId}`
  );
}

async function updateExtensionAttribute2(client, userId, extensionAttribute2, maxRetries, logger) {
  return executeWithRetry(
    () =>
      client.api(`/users/${userId}`).update({
        onPremisesExtensionAttributes: {
          extensionAttribute2
        }
      }),
    maxRetries,
    logger,
    `update extensionAttribute2 for user ${userId}`
  );
}

module.exports = {
  createGraphClient,
  getServicePrincipal,
  getAppAssignments,
  getTransitiveGroupUsers,
  getUser,
  updateExtensionAttribute2
};