import type { Pool } from 'pg';

/**
 * Lakebase (Postgres) 接続プール。
 * Databricks Apps 上では postgres リソースにより PGHOST / PGDATABASE / PGUSER / LAKEBASE_ENDPOINT が注入され、
 * @databricks/lakebase が OAuth トークンの取得・更新を行う。
 * テストでは setPool() で差し替える（pg-mem など）。
 */
let pool: Pool | undefined;

export const setPool = (p: Pool): void => {
  pool = p;
};

export const getPool = async (): Promise<Pool> => {
  if (!pool) {
    const { createLakebasePool } = await import('@databricks/lakebase');
    pool = createLakebasePool() as unknown as Pool;
  }
  return pool;
};

/** アプリ用テーブルを置くスキーマ（SP が作成・所有する） */
export const DB_SCHEMA = process.env.GENAI_DB_SCHEMA ?? 'genai';
