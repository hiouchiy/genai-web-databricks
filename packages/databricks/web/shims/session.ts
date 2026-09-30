/**
 * ブラウザ側の共通処理。
 * - ログインユーザー: Databricks Apps の SSO セッション（Cookie）で /api/me から取得（Cognito セッションの代替）
 * - fetch フック:
 *   1. 同一オリジン API への Authorization ヘッダを外す（Apps のプロキシに Databricks トークンと誤認されないように）
 *   2. S3 署名付き URL（https://<bucket>.s3.<region>.amazonaws.com/...）を同一オリジンの /_s3/<bucket>/... に付け替える
 */
export type Me = { sub: string; email: string; groups: string[]; idToken: string };

let mePromise: Promise<Me> | undefined;
export const getMe = (): Promise<Me> =>
  (mePromise ??= fetch('/api/me', { credentials: 'include' }).then(async (r) => {
    if (!r.ok) {
      mePromise = undefined;
      throw new Error(`not signed in (${r.status})`);
    }
    return r.json();
  }));

const S3_HOST = /^([^.]+)\.s3[.-]([^.]+\.)?amazonaws\.com$/;

export const toLocalUrl = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input, window.location.origin);
  } catch {
    return input;
  }
  const m = S3_HOST.exec(url.hostname);
  if (!m) return input;
  return `${window.location.origin}/_s3/${m[1]}${url.pathname}${url.search}`;
};

const install = () => {
  const w = window as unknown as { __genaiFetchPatched?: boolean };
  if (w.__genaiFetchPatched) return;
  w.__genaiFetchPatched = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const target = toLocalUrl(raw);
    const url = new URL(target, window.location.origin);
    if (url.origin === window.location.origin) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete('authorization');
      return original(target, { ...init, headers, credentials: 'include' });
    }
    return original(input, init);
  };
};
install();
