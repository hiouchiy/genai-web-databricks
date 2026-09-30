/**
 * CDK（packages/cdk/lib/construct/*.ts）で Lambda に渡していた環境変数の Databricks 版。
 * 値は AWS リソース名の代わりに Lakebase のテーブル名・UC Volume 上のバケット名などを指す。
 */
export const TABLES = {
  chat: 'genai_chat',
  team: 'genai_team',
  exApp: 'genai_exapp',
  invokeHistory: 'genai_invoke_history',
  passwordReset: 'genai_password_reset',
} as const;

export const POLLING_QUEUE_URL = 'https://sqs.local/genai/exapp-polling';

const DEFAULT_MODEL_IDS = [
  'jp.anthropic.claude-sonnet-4-6',
  'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
];

/** 全 Lambda 共通の環境変数（process.env に既定値として流し込む） */
export const commonEnv = (): Record<string, string> => ({
  AWS_REGION: 'ap-northeast-1',
  MODEL_REGION: 'ap-northeast-1',
  MODEL_IDS: process.env.MODEL_IDS ?? JSON.stringify(DEFAULT_MODEL_IDS),
  IMAGE_GENERATION_MODEL_IDS: '[]',
  CROSS_ACCOUNT_BEDROCK_ROLE_ARN: '',
  USER_POOL_ID: 'ap-northeast-1_databricks',
  USER_POOL_CLIENT_ID: 'databricks',
  BUCKET_NAME: 'genai-files',
  ARTIFACTS_BUCKET_NAME: 'genai-artifacts',
  EXAPP_TABLE_NAME: TABLES.exApp,
  INVOKE_HISTORY_TABLE_NAME: TABLES.invokeHistory,
  PASSWORD_RESET_TABLE_NAME: TABLES.passwordReset,
  POLLING_QUEUE_URL,
  TTL_DAYS: '364',
  APP_ENV: process.env.APP_ENV ?? 'dbx',
  USER_IDENTIFIER_HMAC_KEY_ID: 'databricks-hmac',
  COST_CONVERSION_TO_CURRENCY: 'JPY',
  COST_CONVERSION_RATE: '150',
  COST_CONVERSION_ALLOWED_FROM: 'USD',
  POWERTOOLS_LOG_LEVEL: 'INFO',
});

/** API グループごとの上書き（CDK 上でメイン API とチーム管理 API は別テーブルを TABLE_NAME に渡していた） */
export const groupEnv: Record<string, Record<string, string>> = {
  main: { TABLE_NAME: TABLES.chat },
  tac: { TABLE_NAME: TABLES.team },
  stream: { TABLE_NAME: TABLES.chat },
};
