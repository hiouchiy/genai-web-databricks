/**
 * Map Bedrock model IDs to Databricks endpoints.
 * Supports both explicit mapping via env DATABRICKS_MODEL_MAP
 * and sensible defaults based on model name patterns.
 */

type ModelMap = Record<string, string>;

function loadModelMap(): ModelMap {
  const mapStr = process.env.DATABRICKS_MODEL_MAP;
  if (mapStr) {
    try {
      return JSON.parse(mapStr) as ModelMap;
    } catch (e) {
      console.warn('Failed to parse DATABRICKS_MODEL_MAP, using defaults', e);
    }
  }
  return {};
}

const customMap = loadModelMap();

/**
 * Map a Bedrock model ID to a Databricks endpoint name.
 */
export function mapModelIdToEndpoint(bedrockModelId: string): string {
  // 1. Check custom mapping first
  if (customMap[bedrockModelId]) {
    return customMap[bedrockModelId];
  }

  // 2. Apply default mappings based on patterns
  if (
    bedrockModelId.includes('claude-sonnet-4-6') ||
    bedrockModelId.includes('sonnet-4-6')
  ) {
    return 'databricks-claude-sonnet-4-6';
  }
  if (bedrockModelId.includes('sonnet-4-5')) {
    return 'databricks-claude-sonnet-4-5';
  }
  if (bedrockModelId.includes('haiku-4-5')) {
    return 'databricks-claude-haiku-4-5';
  }
  if (bedrockModelId.includes('opus-4-6')) {
    return 'databricks-claude-opus-4-6';
  }
  if (bedrockModelId.includes('nova-')) {
    return 'databricks-claude-haiku-4-5';
  }

  // 3. If already prefixed with databricks-, use as-is
  if (bedrockModelId.startsWith('databricks-')) {
    return bedrockModelId;
  }

  // 4. Fall back to default endpoint (from env or hardcoded)
  return process.env.DATABRICKS_DEFAULT_CHAT_ENDPOINT || 'databricks-claude-sonnet-4-6';
}
