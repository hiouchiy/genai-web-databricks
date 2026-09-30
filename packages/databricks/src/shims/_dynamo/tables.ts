/**
 * DynamoDB table key schema registry for Postgres backend.
 * Maps table names to their key schemas and GSIs.
 */

export interface KeySchema {
  name: string;
  type: 'S' | 'N' | 'B';
}

export interface GSI {
  pk: KeySchema;
  sk?: KeySchema;
}

export interface TableSchema {
  pk: KeySchema;
  sk?: KeySchema;
  gsis?: { [indexName: string]: GSI };
}

export interface TableRegistry {
  [tableName: string]: TableSchema;
}

/**
 * テーブル名 → キースキーマ。
 * 1 プロセスに複数の Lambda バンドルが同居し、TABLE_NAME はバンドルごとに
 * チャット用（genai_chat）/ チーム用（genai_team）と値が異なるため、env ではなくテーブル名そのもので引く。
 * テーブル名は server/config.ts の TABLES と一致させること。
 */
export function buildTableRegistry(): TableRegistry {
  return {
    genai_chat: {
      pk: { name: 'id', type: 'S' },
      sk: { name: 'createdDate', type: 'S' },
      gsis: { FeedbackIndex: { pk: { name: 'feedback', type: 'S' } } },
    },
    genai_team: {
      pk: { name: 'pk', type: 'S' },
      sk: { name: 'sk', type: 'S' },
      gsis: { 'GSI-1': { pk: { name: 'sk', type: 'S' }, sk: { name: 'pk', type: 'S' } } },
    },
    genai_exapp: {
      pk: { name: 'pk', type: 'S' },
      sk: { name: 'sk', type: 'S' },
    },
    genai_invoke_history: {
      pk: { name: 'pk', type: 'S' },
      sk: { name: 'sk', type: 'S' },
    },
    genai_password_reset: {
      pk: { name: 'recordId', type: 'S' },
      gsis: {
        EmailHashIndex: {
          pk: { name: 'emailHash', type: 'S' },
          sk: { name: 'requestedAt', type: 'N' },
        },
      },
    },
  };
}

let registryCache: TableRegistry | undefined;

export function getTableRegistry(): TableRegistry {
  if (!registryCache) {
    registryCache = buildTableRegistry();
  }
  return registryCache;
}

export function getTableSchema(tableName: string): TableSchema {
  const registry = getTableRegistry();
  const schema = registry[tableName];
  if (!schema) {
    throw new Error(`Table ${tableName} not found in registry`);
  }
  return schema;
}

export function getGSISchema(tableName: string, indexName: string): GSI {
  const schema = getTableSchema(tableName);
  const gsi = schema.gsis?.[indexName];
  if (!gsi) {
    throw new Error(`GSI ${indexName} not found in table ${tableName}`);
  }
  return gsi;
}
