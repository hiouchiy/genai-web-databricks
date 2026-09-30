/**
 * Databricks Apps 用の成果物を dist/ に作る。
 *   dist/server.cjs                     … Express サーバ
 *   dist/lambda/<name>.cjs              … 元の Lambda ハンドラ（packages/cdk/lambda を無改変でバンドル）
 *   dist/shims/@aws-sdk/<pkg>/index.js  … AWS SDK 互換シム（NODE_PATH で解決される）
 *   dist/shims/genai-dbx-runtime/       … シム間で共有するランタイム（DB プール・トークン等）
 *   dist/web/                           … React SPA（packages/web を無改変でビルド、Amplify 等を alias で差し替え）
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const repo = path.resolve(pkg, '..', '..');
const dist = path.join(pkg, 'dist');
const lambdaSrc = path.join(repo, 'packages', 'cdk', 'lambda');
const only = process.argv.slice(2);
const want = (step) => only.length === 0 || only.includes(step);

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'warning',
  keepNames: true,
  // シム・共有ランタイムは実行時に NODE_PATH から解決させる（Lambda バンドル間でシングルトンを共有するため）
  external: ['@aws-sdk/*', 'genai-dbx-runtime'],
  alias: {},
};

if (want('shims')) {
  fs.rmSync(path.join(dist, 'shims'), { recursive: true, force: true });
  await esbuild.build({
    ...common,
    external: ['@aws-sdk/*'],
    entryPoints: [path.join(pkg, 'src', 'runtime', 'index.ts')],
    outfile: path.join(dist, 'shims', 'genai-dbx-runtime', 'index.js'),
  });
  const shimRoot = path.join(pkg, 'src', 'shims', '@aws-sdk');
  for (const name of fs.readdirSync(shimRoot)) {
    const entry = path.join(shimRoot, name, 'index.ts');
    if (!fs.existsSync(entry)) continue;
    await esbuild.build({
      ...common,
      entryPoints: [entry],
      outfile: path.join(dist, 'shims', '@aws-sdk', name, 'index.js'),
    });
  }
  // package.json の "type": "module" の影響を受けないよう CJS であることを明示
  fs.writeFileSync(path.join(dist, 'shims', 'package.json'), '{"type":"commonjs"}\n');
  console.log('✓ shims');
}

if (want('lambda')) {
  fs.rmSync(path.join(dist, 'lambda'), { recursive: true, force: true });
  const routes = JSON.parse(fs.readFileSync(path.join(pkg, 'routes.json'), 'utf8'));
  const entries = [...new Set([...routes.map((r) => r.entry), 'predictStream', 'pollExAppStatus'])];
  await esbuild.build({
    ...common,
    entryPoints: Object.fromEntries(entries.map((e) => [e, path.join(lambdaSrc, `${e}.ts`)])),
    outdir: path.join(dist, 'lambda'),
    outExtension: { '.js': '.cjs' },
    tsconfig: path.join(repo, 'packages', 'cdk', 'tsconfig.json'),
  });
  // 解決されない外部依存がないか確認（シムが存在しない @aws-sdk パッケージを検出）
  const missing = new Set();
  for (const f of fs.readdirSync(path.join(dist, 'lambda'))) {
    const code = fs.readFileSync(path.join(dist, 'lambda', f), 'utf8');
    for (const m of code.matchAll(/require\("(@aws-sdk\/[^"]+)"\)/g)) {
      if (!fs.existsSync(path.join(dist, 'shims', m[1], 'index.js'))) missing.add(`${m[1]} (${f})`);
    }
  }
  if (missing.size) {
    console.warn(`⚠ シム未実装の依存: \n  ${[...missing].join('\n  ')}`);
  }
  console.log(`✓ lambda (${entries.length} functions)`);
}

if (want('server')) {
  await esbuild.build({
    ...common,
    entryPoints: [path.join(pkg, 'src', 'server', 'main.ts')],
    outfile: path.join(dist, 'server.cjs'),
  });
  console.log('✓ server');
}

if (want('web')) {
  const appUrl = process.env.GENAI_APP_URL;
  if (!appUrl) throw new Error('GENAI_APP_URL（Databricks App の URL）を指定してください');
  execSync('npx vite build --config ../databricks/web/vite.databricks.config.ts', {
    cwd: path.join(repo, 'packages', 'web'),
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_APP_VERSION: JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version,
      VITE_APP_API_ENDPOINT: `${appUrl}/api/main/`,
      VITE_APP_TEAM_ACCESS_CONTROL_API_ENDPOINT: `${appUrl}/api/tac/`,
      VITE_APP_REGION: 'ap-northeast-1',
      VITE_APP_USER_POOL_ID: 'ap-northeast-1_databricks',
      VITE_APP_USER_POOL_CLIENT_ID: 'databricks',
      VITE_APP_IDENTITY_POOL_ID: 'databricks:identity-pool',
      VITE_APP_PREDICT_STREAM_FUNCTION_ARN: 'predictStream',
      VITE_APP_MODEL_REGION: 'ap-northeast-1',
      VITE_APP_MODEL_IDS: JSON.stringify([
        'jp.anthropic.claude-sonnet-4-6',
        'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
      ]),
      VITE_APP_DEFAULT_MODEL_ID: 'jp.anthropic.claude-sonnet-4-6',
      VITE_APP_IMAGE_MODEL_IDS: '[]',
      VITE_APP_ENDPOINT_NAMES: '[]',
      VITE_APP_SAMLAUTH_ENABLED: 'false',
      VITE_APP_SELF_SIGN_UP_ENABLED: 'false',
      VITE_APP_EMAIL_MFA_REQUIRED: 'false',
      VITE_APP_HIDDEN_USE_CASES: JSON.stringify({ transcribe: true, generateImage: true }),
      VITE_APP_ENV: 'databricks',
      VITE_APP_RECENTLY_USED_APPS_ENABLED: 'true',
    },
  });
  console.log('✓ web');
}

if (want('app')) {
  // app.yaml.tmpl の ${VAR} を環境変数で置換（ワークスペース固有の値をリポジトリに持たない）
  const tmpl = fs.readFileSync(path.join(pkg, 'app.yaml.tmpl'), 'utf8');
  const rendered = tmpl.replace(/\$\{(\w+)\}/g, (_m, k) => {
    if (!process.env[k]) throw new Error(`app.yaml の生成に環境変数 ${k} が必要です`);
    return process.env[k];
  });
  fs.writeFileSync(path.join(dist, 'app.yaml'), rendered);
  console.log('✓ app.yaml');
}
