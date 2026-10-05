export function pluginMarketplaceEnvironment(environment) {
  const env = { ...environment };
  delete env.KIKI_PLUGIN_MARKETPLACE_FROM_DEV_SERVER;
  const explicit = env.KIKI_DEV_MARKETPLACE_URL?.trim();
  if (explicit) env.KIKI_PLUGIN_MARKETPLACE_URL = explicit;
  return env;
}
