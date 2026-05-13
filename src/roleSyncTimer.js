const { app } = require("@azure/functions");

const { getConfig } = require("./config");
const {
  createGraphClient,
  getServicePrincipal,
  getAppAssignments,
  getTransitiveGroupUsers,
  getUser,
  updateExtensionAttribute2
} = require("./graphClient");

function buildRoleLookup(appRoles) {
  const byId = new Map();
  let targetRoleId = null;

  for (const role of appRoles || []) {
    byId.set(role.id, role);

    if (role.value === config.targetAppRoleValue && role.displayName === config.targetAppRoleDisplayName) {
      targetRoleId = role.id;
    }
  }

  return { byId, targetRoleId };
}

function deriveProvisioningUserName(upn, userId) {
  const separatorIndex = upn.indexOf("@");
  if (separatorIndex < 1) {
    throw new Error(`UPN ${upn} is not in a supported format`);
  }

  const localPart = upn.slice(0, separatorIndex);
  const domainPart = upn.slice(separatorIndex);
  return `${localPart}-${userId.slice(0, 8)}${domainPart}`;
}

function getCurrentExtensionAttribute2(user) {
  return user.onPremisesExtensionAttributes?.extensionAttribute2 || "";
}

function resolveRunConfig(overrides = {}) {
  return {
    ...getConfig(),
    ...overrides,
    dryRun: overrides.dryRun !== undefined ? overrides.dryRun : getConfig().dryRun
  };
}

async function loadScopedUsers(client, config, logger, targetRoleId) {
  const assignments = await getAppAssignments(client, config.targetServicePrincipalId, config.maxGraphRetries, logger);
  const allUserIds = new Set();
  const targetRoleUserIds = new Set();
  const allGroupIds = new Set();
  const targetRoleGroupIds = new Set();

  for (const assignment of assignments) {
    if (assignment.principalType === "User") {
      allUserIds.add(assignment.principalId);

      if (assignment.appRoleId === targetRoleId) {
        targetRoleUserIds.add(assignment.principalId);
      }
    }

    if (assignment.principalType === "Group") {
      allGroupIds.add(assignment.principalId);

      if (assignment.appRoleId === targetRoleId) {
        targetRoleGroupIds.add(assignment.principalId);
      }
    }
  }

  for (const groupId of allGroupIds) {
    const members = await getTransitiveGroupUsers(client, groupId, config.maxGraphRetries, logger);
    for (const member of members) {
      allUserIds.add(member.id);
    }
  }

  for (const groupId of targetRoleGroupIds) {
    const members = await getTransitiveGroupUsers(client, groupId, config.maxGraphRetries, logger);
    for (const member of members) {
      targetRoleUserIds.add(member.id);
    }
  }

  return {
    allUserIds: Array.from(allUserIds),
    targetRoleUserIds
  };
}

async function syncUsers(context, overrides = {}) {
  const logger = context;
  const config = resolveRunConfig(overrides);
  const client = createGraphClient(config);
  const result = {
    enterpriseAppName: config.targetEnterpriseAppName,
    applicationId: config.targetApplicationId,
    servicePrincipalId: config.targetServicePrincipalId,
    targetAppRoleValue: config.targetAppRoleValue,
    targetAppRoleDisplayName: config.targetAppRoleDisplayName,
    dryRun: config.dryRun,
    scopedUserCount: 0,
    targetRoleUserCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    impactedUsers: []
  };

  logger.log("Starting role sync", {
    enterpriseAppName: config.targetEnterpriseAppName,
    applicationId: config.targetApplicationId,
    servicePrincipalId: config.targetServicePrincipalId,
    targetAppRoleValue: config.targetAppRoleValue,
    targetAppRoleDisplayName: config.targetAppRoleDisplayName,
    dryRun: config.dryRun
  });

  const servicePrincipal = await getServicePrincipal(client, config.targetServicePrincipalId, config.maxGraphRetries, logger);
  if (servicePrincipal.appId !== config.targetApplicationId) {
    throw new Error(
      `Configured application ID ${config.targetApplicationId} does not match service principal appId ${servicePrincipal.appId}`
    );
  }

  if (servicePrincipal.displayName !== config.targetEnterpriseAppName) {
    logger.warn("Configured enterprise app name does not match service principal display name", {
      configuredName: config.targetEnterpriseAppName,
      actualName: servicePrincipal.displayName
    });
  }

  const roleById = new Map();
  let targetRoleId = null;
  for (const role of servicePrincipal.appRoles || []) {
    roleById.set(role.id, role);
    if (role.value === config.targetAppRoleValue && role.displayName === config.targetAppRoleDisplayName) {
      targetRoleId = role.id;
    }
  }

  if (!targetRoleId) {
    throw new Error(
      `Could not find app role with display name ${config.targetAppRoleDisplayName} and value ${config.targetAppRoleValue}`
    );
  }

  const { allUserIds, targetRoleUserIds } = await loadScopedUsers(client, config, logger, targetRoleId);
  result.scopedUserCount = allUserIds.length;
  result.targetRoleUserCount = targetRoleUserIds.size;

  logger.log("Resolved app assignments", {
    scopedUserCount: allUserIds.length,
    targetRoleUserCount: targetRoleUserIds.size
  });

  let updatedCount = 0;
  let skippedCount = 0;

  for (const userId of allUserIds) {
    const user = await getUser(client, userId, config.maxGraphRetries, logger);
    const hasTargetRole = targetRoleUserIds.has(user.id);

    if (!hasTargetRole) {
      skippedCount += 1;
      logger.log("Skipping non-target user", {
        userId: user.id,
        userPrincipalName: user.userPrincipalName
      });
      continue;
    }

    const desiredValue = deriveProvisioningUserName(user.userPrincipalName, user.id);
    const currentValue = getCurrentExtensionAttribute2(user);

    if (currentValue === desiredValue) {
      skippedCount += 1;
      logger.log("No update needed for user", {
        userId: user.id,
        userPrincipalName: user.userPrincipalName,
        desiredValue,
        hasTargetRole
      });
      continue;
    }

    const impactedUser = {
      userId: user.id,
      userPrincipalName: user.userPrincipalName,
      currentExtensionAttribute2: currentValue,
      newExtensionAttribute2: desiredValue,
      action: config.dryRun ? "wouldUpdate" : "updated"
    };

    logger.log("Updating user extensionAttribute2", {
      userId: user.id,
      userPrincipalName: user.userPrincipalName,
      currentValue,
      desiredValue,
      hasTargetRole
    });

    if (!config.dryRun) {
      await updateExtensionAttribute2(client, user.id, desiredValue, config.maxGraphRetries, logger);
    }

    result.impactedUsers.push(impactedUser);
    updatedCount += 1;
  }

  result.updatedCount = updatedCount;
  result.skippedCount = skippedCount;

  logger.log("Completed role sync", {
    scopedUserCount: allUserIds.length,
    targetRoleUserCount: targetRoleUserIds.size,
    updatedCount,
    skippedCount,
    dryRun: config.dryRun
  });

  return result;
}

app.timer("roleSyncTimer", {
  schedule: process.env.TIMER_SCHEDULE || "0 30 3 * * *",
  runOnStartup: process.env.RUN_ON_STARTUP === "true",
  handler: async (_timer, context) => {
    await syncUsers(context);
  }
});

module.exports = {
  deriveProvisioningUserName,
  getCurrentExtensionAttribute2,
  syncUsers
};