import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';

/**
 * 元の Lambda ハンドラ（esbuild で 1 関数 = 1 バンドルにしたもの）をロードする。
 * Lambda ごとに異なる環境変数（例: TABLE_NAME がチャット用かチーム用か）は、
 * モジュール評価時に読まれるため、ロード中だけ上書きして Lambda と同じ条件を再現する。
 */
const requireCjs = createRequire(__filename);

/**
 * `@aws-sdk/*` と共有ランタイムは必ず dist/shims のシムに解決させる。
 * （NODE_PATH は node_modules より優先度が低く、ローカルでは本物の AWS SDK が見つかってしまうため）
 */
const SHIM_DIR = path.join(__dirname, 'shims');
const ModuleImpl = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const originalResolve = ModuleImpl._resolveFilename;
ModuleImpl._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request.startsWith('@aws-sdk/') || request === 'genai-dbx-runtime') {
    const shim = path.join(SHIM_DIR, request, 'index.js');
    if (fs.existsSync(shim)) return shim;
    throw new Error(`No Databricks shim for ${request}`);
  }
  return originalResolve.call(this, request, ...rest);
};

// Lambda ランタイムが提供するグローバル（レスポンスストリーミング）
(globalThis as unknown as { awslambda: unknown }).awslambda = {
  streamifyResponse: <T>(f: T) => f,
  HttpResponseStream: { from: <T>(s: T) => s },
};

// biome-ignore lint/suspicious/noExplicitAny: Lambda handler は形がまちまち
export type LambdaModule = Record<string, any>;

const loaded = new Map<string, LambdaModule>();

export const loadLambda = (
  bundleDir: string,
  entry: string,
  envOverride: Record<string, string> = {},
): LambdaModule => {
  const cached = loaded.get(entry);
  if (cached) return cached;
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envOverride)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const mod = requireCjs(path.join(bundleDir, `${entry}.cjs`)) as LambdaModule;
    loaded.set(entry, mod);
    return mod;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};
