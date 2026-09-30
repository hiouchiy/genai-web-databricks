import crypto from 'node:crypto';
import { databricksFetch } from './databricksAuth';

/**
 * S3 の (bucket, key) を Unity Catalog Volume 上のパスに対応付けて Files API で読み書きする。
 *   s3://<bucket>/<key>  →  <GENAI_VOLUME_ROOT>/<bucket>/<key>
 */
const volumeRoot = () => {
  const root = process.env.GENAI_VOLUME_ROOT;
  if (!root) throw new Error('GENAI_VOLUME_ROOT（例: /Volumes/<catalog>/genai/files）が設定されていません');
  return root.replace(/\/$/, '');
};

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export const volumePath = (bucket: string, key: string) => `${volumeRoot()}/${bucket}/${key}`;

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSuchKey';
  }
}

export const putFile = async (
  bucket: string,
  key: string,
  body: Uint8Array | Buffer | string,
): Promise<void> => {
  const res = await databricksFetch(
    `/api/2.0/fs/files${encodePath(volumePath(bucket, key))}?overwrite=true`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: typeof body === 'string' ? body : new Uint8Array(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Volume PUT failed (${res.status}): ${await res.text()}`);
  }
};

export const getFile = async (bucket: string, key: string): Promise<Buffer> => {
  const res = await databricksFetch(`/api/2.0/fs/files${encodePath(volumePath(bucket, key))}`);
  if (res.status === 404) {
    throw new FileNotFoundError(`${bucket}/${key} not found`);
  }
  if (!res.ok) {
    throw new Error(`Volume GET failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
};

export const deleteFile = async (bucket: string, key: string): Promise<void> => {
  const res = await databricksFetch(`/api/2.0/fs/files${encodePath(volumePath(bucket, key))}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Volume DELETE failed (${res.status}): ${await res.text()}`);
  }
};

export const listFiles = async (bucket: string, prefix: string): Promise<string[]> => {
  // prefix をディレクトリとして再帰的に列挙する（小規模データ想定）
  const base = volumePath(bucket, '');
  const dir = volumePath(bucket, prefix.replace(/\/[^/]*$/, ''));
  const out: string[] = [];
  const walk = async (d: string) => {
    let token: string | undefined;
    do {
      const q = token ? `?page_token=${encodeURIComponent(token)}` : '';
      const res = await databricksFetch(`/api/2.0/fs/directories${encodePath(d)}${q}`);
      if (res.status === 404) return;
      if (!res.ok) throw new Error(`Volume LIST failed (${res.status}): ${await res.text()}`);
      const json = (await res.json()) as {
        contents?: { path: string; is_directory: boolean }[];
        next_page_token?: string;
      };
      for (const c of json.contents ?? []) {
        if (c.is_directory) await walk(c.path);
        else out.push(c.path.slice(base.length));
      }
      token = json.next_page_token;
    } while (token);
  };
  await walk(dir);
  return out.filter((k) => k.startsWith(prefix));
};

/* ---------- 署名付き URL（S3 presigned URL 互換） ---------- */

const signingKey = () => process.env.GENAI_URL_SIGNING_KEY ?? process.env.DATABRICKS_CLIENT_SECRET ?? 'local-dev';

const sign = (method: string, bucket: string, key: string, expires: number) =>
  crypto
    .createHmac('sha256', signingKey())
    .update(`${method}\n${bucket}\n${key}\n${expires}`)
    .digest('hex');

/**
 * S3 と同じ形式 https://<bucket>.s3.<region>.amazonaws.com/<key>?... の URL を返す。
 * 元コード（フロント / Lambda）が URL からバケット・キーを解析するため形式を合わせている。
 * ブラウザ側シムがこのホストへのリクエストを同一オリジンの /_s3/<bucket>/<key> に付け替える。
 */
export const presignUrl = (
  method: 'GET' | 'PUT',
  bucket: string,
  key: string,
  expiresIn: number,
  contentType?: string,
): string => {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const region = process.env.AWS_REGION ?? 'ap-northeast-1';
  const params = new URLSearchParams({
    'X-Dbx-Method': method,
    'X-Dbx-Expires': String(expires),
    'X-Dbx-Signature': sign(method, bucket, key, expires),
  });
  if (contentType) params.set('response-content-type', contentType);
  // ダウンロード用（GET）は <img src> 等でそのまま使われるため同一オリジンの相対パスで返す
  if (method === 'GET') return `/_s3/${bucket}/${encodePath(key)}?${params}`;
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodePath(key)}?${params}`;
};

export const verifySignedRequest = (
  method: string,
  bucket: string,
  key: string,
  query: Record<string, unknown>,
): boolean => {
  const expires = Number(query['X-Dbx-Expires']);
  const sig = String(query['X-Dbx-Signature'] ?? '');
  if (query['X-Dbx-Method'] !== method || !Number.isFinite(expires)) return false;
  if (expires < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(method, bucket, key, expires);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
};
