const fs = require("fs");
const os = require("os");
const path = require("path");

const BUNDLED_EXECUTOR_MODEL_CONFIG = path.join(__dirname, "..", "references", "executor-models.json");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonConfig(filePath, { optional = false } = {}) {
  if (optional && !fs.existsSync(filePath)) return {};

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (optional) {
      console.error(`Warning: ignoring optional executor model config at ${filePath}: ${error.message}`);
      return {};
    }
    throw new Error(`failed to read executor model config at ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    if (optional) {
      console.error(`Warning: ignoring optional executor model config at ${filePath}: ${error.message}`);
      return {};
    }
    throw new Error(`failed to parse executor model config at ${filePath}: ${error.message}`);
  }
}

function validateExecutorModelConfig(config, filePath) {
  if (!isPlainObject(config)) {
    throw new Error(`invalid executor model config at ${filePath}: expected object`);
  }
  if (config.executors === undefined) return config;
  if (!isPlainObject(config.executors)) {
    throw new Error(`invalid executor model config at ${filePath}: executors must be an object`);
  }

  for (const [executor, executorConfig] of Object.entries(config.executors)) {
    if (!isPlainObject(executorConfig)) {
      throw new Error(`invalid executor model config at ${filePath}: executors.${executor} must be an object`);
    }
    if (
      executorConfig.default_model !== undefined &&
      (typeof executorConfig.default_model !== "string" || !executorConfig.default_model.trim())
    ) {
      throw new Error(`invalid executor model config at ${filePath}: executors.${executor}.default_model must be a non-empty string`);
    }
    if (executorConfig.candidate_models !== undefined) {
      if (!Array.isArray(executorConfig.candidate_models)) {
        throw new Error(`invalid executor model config at ${filePath}: executors.${executor}.candidate_models must be an array`);
      }
      for (const [index, model] of executorConfig.candidate_models.entries()) {
        if (typeof model !== "string" || !model.trim()) {
          throw new Error(
            `invalid executor model config at ${filePath}: executors.${executor}.candidate_models[${index}] must be a non-empty string`
          );
        }
      }
    }
  }

  return config;
}

function readOptionalExecutorModelConfig(filePath) {
  try {
    return validateExecutorModelConfig(readJsonConfig(filePath, { optional: true }), filePath);
  } catch (error) {
    console.error(`Warning: ignoring optional executor model config at ${filePath}: ${error.message}`);
    return {};
  }
}

function mergeExecutorModelConfigs(base, override) {
  const merged = {
    ...base,
    executors: {
      ...(base.executors || {}),
    },
  };

  for (const [executor, executorConfig] of Object.entries(override.executors || {})) {
    merged.executors[executor] = {
      ...(merged.executors[executor] || {}),
      ...executorConfig,
    };
  }

  return merged;
}

function resolveLocalExecutorModelConfigPath(relayHome) {
  const home = relayHome || process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  return path.join(home, "executors.json");
}

function resolveRoutesConfigPath(relayHome) {
  const home = relayHome || process.env.RELAY_HOME || path.join(os.homedir(), ".relay");
  return path.join(home, "routes.json");
}

function routesConfigToExecutorModelConfig(routeConfig, sourceLabel) {
  const executors = {};
  for (const [executor, config] of Object.entries(routeConfig?.executor_defaults || {})) {
    const model = typeof config?.model === "string" ? config.model.trim() : "";
    if (model) {
      executors[executor] = { default_model: model };
    }
  }
  return validateExecutorModelConfig({ executors }, sourceLabel);
}

function readOptionalRoutesExecutorModelConfig({ relayHome, repoRoot, globalPath, projectPath } = {}) {
  const resolvedGlobalPath = globalPath || resolveRoutesConfigPath(relayHome);
  // No cwd fallback: without an explicit repoRoot only the global scope may
  // contribute, otherwise an unrelated project's routes could leak into
  // default-model resolution.
  const effectiveRepoRoot = repoRoot || null;
  if (!fs.existsSync(resolvedGlobalPath) && !projectPath) return null;
  try {
    const { loadRouteConfig } = require("./relay-routing");
    const result = loadRouteConfig({
      repoRoot: effectiveRepoRoot,
      relayHome,
      globalPath: resolvedGlobalPath,
      projectPath,
    });
    if (result.status === "absent") return null;
    if (!result.ok) {
      const message = result.errors?.map((error) => error.message).join("; ") || "invalid routes config";
      console.error(`Warning: ignoring routes executor defaults at ${resolvedGlobalPath}: ${message}`);
      return { executors: {} };
    }
    return routesConfigToExecutorModelConfig(result.config, resolvedGlobalPath);
  } catch (error) {
    console.error(`Warning: ignoring routes executor defaults at ${resolvedGlobalPath}: ${error.message}`);
    return { executors: {} };
  }
}

function loadExecutorModelConfig({ relayHome, repoRoot, bundledPath = BUNDLED_EXECUTOR_MODEL_CONFIG, localPath, routesPath, projectRoutesPath } = {}) {
  const bundled = validateExecutorModelConfig(readJsonConfig(bundledPath), bundledPath);
  const routesConfig = localPath ? null : readOptionalRoutesExecutorModelConfig({
    relayHome,
    repoRoot,
    globalPath: routesPath,
    projectPath: projectRoutesPath,
  });
  if (routesConfig) {
    return mergeExecutorModelConfigs(bundled, routesConfig);
  }
  const resolvedLocalPath = localPath || resolveLocalExecutorModelConfigPath(relayHome);
  const local = readOptionalExecutorModelConfig(resolvedLocalPath);
  return mergeExecutorModelConfigs(bundled, local);
}

function resolveExecutorDefaultModel(executor, options = {}) {
  const bundledPath = options.bundledPath || BUNDLED_EXECUTOR_MODEL_CONFIG;
  const bundled = validateExecutorModelConfig(readJsonConfig(bundledPath), bundledPath);
  const routesConfig = options.localPath ? null : readOptionalRoutesExecutorModelConfig({
    relayHome: options.relayHome,
    repoRoot: options.repoRoot,
    globalPath: options.routesPath,
    projectPath: options.projectRoutesPath,
  });
  if (routesConfig) {
    const config = mergeExecutorModelConfigs(bundled, routesConfig);
    const value = config.executors?.[executor]?.default_model;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const resolvedLocalPath = options.localPath || resolveLocalExecutorModelConfigPath(options.relayHome);
  const local = readOptionalExecutorModelConfig(resolvedLocalPath);
  const config = mergeExecutorModelConfigs(bundled, local);
  const value = config.executors?.[executor]?.default_model;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = {
  BUNDLED_EXECUTOR_MODEL_CONFIG,
  loadExecutorModelConfig,
  mergeExecutorModelConfigs,
  resolveExecutorDefaultModel,
  resolveLocalExecutorModelConfigPath,
  resolveRoutesConfigPath,
  validateExecutorModelConfig,
};
