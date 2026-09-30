// シムへのモジュール解決フックを最初に仕込む
import { loadLambda } from './lambdaHost';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { files, getDatabricksToken, identity, queue } from 'genai-dbx-runtime';
import routes from '../../routes.json';
import { commonEnv, groupEnv, POLLING_QUEUE_URL } from './config';
import { type RequestUser, lambdaContext, toApiGatewayEvent } from './event';

/**
 * 源内 Web を Databricks Apps で動かすサーバ。
 * - /api/main/*  … 元のメイン API（API Gateway #1）の Lambda をそのまま実行
 * - /api/tac/*   … 元のチーム・AI アプリ管理 API（API Gateway #2）の Lambda をそのまま実行
 * - /api/predict-stream … Lambda レスポンスストリーミング（predictStream）の代替
 * - /_s3/<bucket>/<key> … S3 署名付き URL の代替（UC Volume へのプロキシ）
 * - それ以外 … React SPA（packages/web のビルド成果物）
 */
const DIST = __dirname;
const LAMBDA_DIR = path.join(DIST, 'lambda');
const WEB_DIR = path.join(DIST, 'web');

for (const [k, v] of Object.entries(commonEnv())) {
  process.env[k] ??= v;
}

/* ---------- AI アプリ（別 Databricks App）呼び出し時に SP の OAuth トークンを付与 ---------- */
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname.endsWith('.databricksapps.com')) {
    const headers = new Headers(init?.headers ?? (input instanceof globalThis.Request ? input.headers : undefined));
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${await getDatabricksToken()}`);
    return originalFetch(input, { ...init, headers });
  }
  return originalFetch(input, init);
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* ---------- 認証: Databricks Apps のプロキシが付与する X-Forwarded-* ヘッダからユーザーを解決 ---------- */
type AuthedRequest = Request & { user?: RequestUser };

const authenticate = async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const user = await identity.resolveRequestUser(req.headers);
    if (!user) {
      res.status(401).json({ error: 'ユーザーを特定できません（Databricks SSO 経由でアクセスしてください）' });
      return;
    }
    req.user = { userId: user.userId, email: user.email, groups: user.groups };
    next();
  } catch (e) {
    next(e);
  }
};

app.get('/api/me', authenticate, (req: AuthedRequest, res) => {
  const u = req.user!;
  res.json({ sub: u.userId, email: u.email, groups: u.groups, idToken: `dbx:${u.userId}` });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/* ---------- 元 Lambda のルーティング（routes.json は CDK から自動抽出） ---------- */
type Route = { api: 'main' | 'tac'; method: string; path: string; entry: string };

const toExpressPath = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

const rawBody = express.text({ type: () => true, limit: '60mb' });

for (const r of routes as Route[]) {
  const mod = loadLambda(LAMBDA_DIR, r.entry, groupEnv[r.api]);
  const method = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
  app[method](`/api/${r.api}${toExpressPath(r.path)}`, authenticate, rawBody, async (req: AuthedRequest, res, next) => {
    try {
      const event = toApiGatewayEvent(req, req.user!, r.path, req.params as Record<string, string>);
      const result = await mod.handler(event, lambdaContext(r.entry));
      res.status(result?.statusCode ?? 200);
      for (const [k, v] of Object.entries(result?.headers ?? {})) {
        if (!/^access-control-/i.test(k)) res.setHeader(k, String(v));
      }
      const body = result?.body ?? '';
      res.send(result?.isBase64Encoded ? Buffer.from(body, 'base64') : body);
    } catch (e) {
      next(e);
    }
  });
}

/* ---------- チャットのストリーミング応答（元: Lambda Response Streaming を Identity Pool 資格情報で直接呼び出し） ---------- */
const predictStream = loadLambda(LAMBDA_DIR, 'predictStream', groupEnv.stream);
app.post('/api/predict-stream', authenticate, express.json({ limit: '60mb' }), async (req: AuthedRequest, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const handler = predictStream.predictStreamHandler ?? predictStream.handler;
    await handler(req.body, res, lambdaContext('predictStream', `dbx-${req.user!.userId}`));
    if (!res.writableEnded) res.end();
  } catch (e) {
    if (res.headersSent) {
      console.error(e);
      res.end();
    } else next(e);
  }
});

/* ---------- 非同期 AI アプリのポーリング（元: SQS → pollExAppStatus Lambda） ---------- */
const poller = loadLambda(LAMBDA_DIR, 'pollExAppStatus', groupEnv.tac);
queue.registerConsumer(POLLING_QUEUE_URL, (event) => poller.handler(event, lambdaContext('pollExAppStatus')));
queue.startQueueWorker();

/* ---------- S3 署名付き URL の代替 ---------- */
app.all('/_s3/:bucket/*key', authenticate, express.raw({ type: () => true, limit: '60mb' }), async (req, res, next) => {
  try {
    const bucket = req.params.bucket as string;
    const key = (Array.isArray(req.params.key) ? req.params.key.join('/') : String(req.params.key));
    const method = req.method === 'PUT' ? 'PUT' : 'GET';
    if (!files.verifySignedRequest(method, bucket, key, req.query)) {
      res.status(403).send('Invalid or expired signature');
      return;
    }
    if (method === 'PUT') {
      await files.putFile(bucket, key, req.body as Buffer);
      res.status(200).end();
      return;
    }
    const buf = await files.getFile(bucket, key);
    const ct = req.query['response-content-type'];
    if (ct) res.setHeader('Content-Type', String(ct));
    else res.type(path.extname(key) || 'application/octet-stream');
    if (req.query['response-content-disposition'] || req.query.download) {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(key))}`);
    }
    res.send(buf);
  } catch (e) {
    if (e instanceof files.FileNotFoundError) res.status(404).send('Not found');
    else next(e);
  }
});

/* ---------- SPA ---------- */
if (fs.existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR, { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(WEB_DIR, 'index.html'));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'サーバ側でエラーが発生しました。管理者へご連絡ください。' });
});

const port = Number(process.env.DATABRICKS_APP_PORT ?? 8000);
app.listen(port, '0.0.0.0', () => {
  console.log(`GENAI web on Databricks listening on :${port} (${(routes as Route[]).length} routes)`);
});
