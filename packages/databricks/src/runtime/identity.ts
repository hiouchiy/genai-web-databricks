import { DB_SCHEMA, getPool } from './db';
import { databricksFetch, getDatabricksHost } from './databricksAuth';

/**
 * Cognito User Pool の代替となるユーザーディレクトリ。
 * - ユーザー実体: Databricks ワークスペースのユーザー（SCIM）。userId (= Cognito の sub 相当) は SCIM の id。
 * - グループ所属: 源内独自のグループ（TeamAdminGroup 等）は Lakebase の user_groups に保持。
 *   - UserGroup は全員に付与（元実装のサインアップ時トリガーと同等）
 *   - SystemAdminGroup はワークスペース管理者（admins グループ）に自動付与
 */
export type DirectoryUser = {
  userId: string;
  email: string;
  displayName?: string;
  workspaceGroups: string[];
};

const ADMIN_WORKSPACE_GROUP = process.env.GENAI_SYSTEM_ADMIN_WORKSPACE_GROUP ?? 'admins';
const USER_GROUP = 'UserGroup';
const SYSTEM_ADMIN_GROUP = 'SystemAdminGroup';

let initialized: Promise<void> | undefined;
const init = () =>
  (initialized ??= (async () => {
    const pool = await getPool();
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.users (
      user_id text PRIMARY KEY, email text NOT NULL, display_name text,
      workspace_groups jsonb NOT NULL DEFAULT '[]', last_seen timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS users_email_idx ON ${DB_SCHEMA}.users (lower(email))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}.user_groups (
      user_id text NOT NULL, group_name text NOT NULL, PRIMARY KEY (user_id, group_name))`);
  })());

type ScimUser = {
  id: string;
  userName: string;
  displayName?: string;
  emails?: { value: string }[];
  groups?: { display: string }[];
};

const toDirectoryUser = (u: ScimUser): DirectoryUser => ({
  userId: u.id,
  email: u.userName ?? u.emails?.[0]?.value,
  displayName: u.displayName,
  workspaceGroups: (u.groups ?? []).map((g) => g.display),
});

const cache = new Map<string, { user: DirectoryUser; at: number }>();
const CACHE_MS = 5 * 60 * 1000;

const scimFind = async (filter: string): Promise<DirectoryUser | undefined> => {
  const res = await databricksFetch(
    `/api/2.0/preview/scim/v2/Users?filter=${encodeURIComponent(filter)}&attributes=id,userName,displayName,emails,groups`,
  );
  if (!res.ok) {
    console.warn(`SCIM lookup failed (${res.status}): ${await res.text()}`);
    return undefined;
  }
  const json = (await res.json()) as { Resources?: ScimUser[] };
  const u = json.Resources?.[0];
  return u ? toDirectoryUser(u) : undefined;
};

const remember = async (user: DirectoryUser) => {
  await init();
  const pool = await getPool();
  await pool.query(
    `INSERT INTO ${DB_SCHEMA}.users (user_id, email, display_name, workspace_groups, last_seen)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
       workspace_groups = EXCLUDED.workspace_groups, last_seen = now()`,
    [user.userId, user.email, user.displayName ?? null, JSON.stringify(user.workspaceGroups)],
  );
  cache.set(`email:${user.email.toLowerCase()}`, { user, at: Date.now() });
  cache.set(`id:${user.userId}`, { user, at: Date.now() });
};

const fromDb = async (where: string, value: string): Promise<DirectoryUser | undefined> => {
  await init();
  const pool = await getPool();
  const r = await pool.query(
    `SELECT user_id, email, display_name, workspace_groups FROM ${DB_SCHEMA}.users WHERE ${where} LIMIT 1`,
    [value],
  );
  const row = r.rows[0];
  return row
    ? { userId: row.user_id, email: row.email, displayName: row.display_name, workspaceGroups: row.workspace_groups }
    : undefined;
};

const scimMe = async (email: string, userToken: string): Promise<DirectoryUser | undefined> => {
  const c = cache.get(`me:${email.toLowerCase()}`);
  if (c && Date.now() - c.at < CACHE_MS) return c.user;
  const res = await fetch(`${getDatabricksHost()}/api/2.0/preview/scim/v2/Me`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (!res.ok) {
    console.warn(`SCIM /Me failed (${res.status})`);
    return undefined;
  }
  const user = toDirectoryUser((await res.json()) as ScimUser);
  await remember(user);
  cache.set(`me:${email.toLowerCase()}`, { user, at: Date.now() });
  return user;
};

export const findUserByEmail = async (email: string): Promise<DirectoryUser | undefined> => {
  const c = cache.get(`email:${email.toLowerCase()}`);
  if (c && Date.now() - c.at < CACHE_MS) return c.user;
  const user = (await scimFind(`userName eq "${email}"`)) ?? (await fromDb('lower(email) = lower($1)', email));
  if (user) await remember(user);
  return user;
};

export const findUserById = async (userId: string): Promise<DirectoryUser | undefined> => {
  const c = cache.get(`id:${userId}`);
  if (c && Date.now() - c.at < CACHE_MS) return c.user;
  const user = (await fromDb('user_id = $1', userId)) ?? (await scimFind(`id eq "${userId}"`));
  if (user) await remember(user);
  return user;
};

export const listGroups = async (userId: string): Promise<string[]> => {
  await init();
  const pool = await getPool();
  const r = await pool.query(`SELECT group_name FROM ${DB_SCHEMA}.user_groups WHERE user_id = $1`, [userId]);
  const groups = new Set<string>([USER_GROUP, ...r.rows.map((x) => x.group_name as string)]);
  const user = await findUserById(userId);
  if (user?.workspaceGroups.includes(ADMIN_WORKSPACE_GROUP)) groups.add(SYSTEM_ADMIN_GROUP);
  return [...groups];
};

export const addToGroup = async (userId: string, group: string): Promise<void> => {
  await init();
  const pool = await getPool();
  await pool.query(
    `INSERT INTO ${DB_SCHEMA}.user_groups (user_id, group_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, group],
  );
};

export const removeFromGroup = async (userId: string, group: string): Promise<void> => {
  await init();
  const pool = await getPool();
  await pool.query(`DELETE FROM ${DB_SCHEMA}.user_groups WHERE user_id = $1 AND group_name = $2`, [userId, group]);
};

/** Databricks 側のユーザーは削除しない（源内側のグループ所属のみ解除） */
export const deleteUser = async (userId: string): Promise<void> => {
  await init();
  const pool = await getPool();
  await pool.query(`DELETE FROM ${DB_SCHEMA}.user_groups WHERE user_id = $1`, [userId]);
};

/** Databricks Apps のリバースプロキシが付与するヘッダからログインユーザーを解決する */
export const resolveRequestUser = async (headers: Record<string, string | string[] | undefined>) => {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const email = h('x-forwarded-email') ?? process.env.GENAI_DEV_USER_EMAIL;
  if (!email) return undefined;
  // ユーザー認可（OBO）トークンがあれば SCIM /Me で本人の所属グループまで取得する
  // （アプリの SP 権限では他ユーザーのグループ所属を参照できないため）
  const userToken = h('x-forwarded-access-token');
  const user = (userToken && (await scimMe(email, userToken))) || (await findUserByEmail(email));
  if (!user) return undefined;
  return { ...user, groups: await listGroups(user.userId) };
};
