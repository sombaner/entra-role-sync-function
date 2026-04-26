function requiredSetting(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required setting ${name}`);
  }

  return value;
}

function optionalInt(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function optionalBool(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

function getConfig() {
  return {
    timerSchedule: process.env.TIMER_SCHEDULE || "0 */15 * * * *",
    tenantId: process.env.GRAPH_TENANT_ID || undefined,
    clientId: process.env.GRAPH_CLIENT_ID || undefined,
    clientSecret: process.env.GRAPH_CLIENT_SECRET || undefined,
    targetServicePrincipalId: requiredSetting("TARGET_SERVICE_PRINCIPAL_ID"),
    targetApplicationId: requiredSetting("TARGET_APPLICATION_ID"),
    targetEnterpriseAppName: requiredSetting("TARGET_ENTERPRISE_APP_NAME"),
    targetAppRoleValue: requiredSetting("TARGET_APP_ROLE_VALUE"),
    targetAppRoleDisplayName: requiredSetting("TARGET_APP_ROLE_DISPLAY_NAME"),
    dryRun: optionalBool("DRY_RUN", true),
    maxGraphRetries: optionalInt("MAX_GRAPH_RETRIES", 4)
  };
}

module.exports = {
  getConfig
};