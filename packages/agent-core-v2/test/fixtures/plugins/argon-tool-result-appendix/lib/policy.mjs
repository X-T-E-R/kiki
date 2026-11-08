export const DEFAULT_STRATEGY = 'tool_result_appendix';
export const DEFAULT_TARGET_MODELS = Object.freeze(['axon-message/gemini-4-argon']);

export function parseTargetModels(raw) {
  if (typeof raw !== 'string') return [...DEFAULT_TARGET_MODELS];
  return raw
    .split(/[\n,;]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function resolvePluginProjectionPolicy({
  enabled = true,
  scopeAllowed = true,
  strategy = DEFAULT_STRATEGY,
  targetModels = DEFAULT_TARGET_MODELS,
  modelAlias = '',
  modelId = '',
  modelName = '',
} = {}) {
  if (!enabled || !scopeAllowed) {
    return { strategy: 'passthrough' };
  }
  const normalizedStrategy =
    strategy === 'passthrough' || strategy === 'tool_result_appendix'
      ? strategy
      : DEFAULT_STRATEGY;
  if (normalizedStrategy !== 'tool_result_appendix') {
    return { strategy: 'passthrough' };
  }
  const list = Array.isArray(targetModels) ? targetModels : parseTargetModels(targetModels);
  const candidates = new Set(
    [modelAlias, modelId, modelName]
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim()),
  );
  const matched = list.some((target) => candidates.has(target.trim()));
  return { strategy: matched ? 'tool_result_appendix' : 'passthrough' };
}
