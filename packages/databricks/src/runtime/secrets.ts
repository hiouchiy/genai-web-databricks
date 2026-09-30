import crypto from 'node:crypto';
import { DB_SCHEMA, getPool } from './db';

/**
 * AWS Secrets Manager の代替。AI アプリの API キーを Lakebase に AES-256-GCM で暗号化して保存する。
 * 暗号鍵は GENAI_SECRETS_KEY（Databricks シークレットから注入）。
 */
let initialized: Promise<void> | undefined;
const init = () =>
  (initialized ??= (async () => {
    const pool = await getPool();
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.secrets (
      name text PRIMARY KEY, ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  })());

const key = () =>
  crypto
    .createHash('sha256')
    .update(process.env.GENAI_SECRETS_KEY ?? process.env.DATABRICKS_CLIENT_SECRET ?? 'local-dev')
    .digest();

const encrypt = (plain: string) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
};

const decrypt = (text: string) => {
  const [iv, tag, enc] = text.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
};

export const getSecret = async (name: string): Promise<string | undefined> => {
  await init();
  const pool = await getPool();
  const r = await pool.query(`SELECT ciphertext FROM ${DB_SCHEMA}.secrets WHERE name = $1`, [name]);
  return r.rows[0] ? decrypt(r.rows[0].ciphertext) : undefined;
};

export const putSecret = async (name: string, value: string): Promise<void> => {
  await init();
  const pool = await getPool();
  await pool.query(
    `INSERT INTO ${DB_SCHEMA}.secrets (name, ciphertext) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
    [name, encrypt(value)],
  );
};

export const deleteSecret = async (name: string): Promise<boolean> => {
  await init();
  const pool = await getPool();
  const r = await pool.query(`DELETE FROM ${DB_SCHEMA}.secrets WHERE name = $1`, [name]);
  return (r.rowCount ?? 0) > 0;
};
