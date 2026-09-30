# genai-databricks

源内 Web を **元コード無改変** のまま Databricks Apps 上で動かすためのランタイム。

- `packages/cdk/lambda` の Lambda ハンドラを 1 関数 = 1 バンドルでロードし、Express から API Gateway 互換イベントで呼ぶ
- `@aws-sdk/*`・`aws-amplify` を Databricks 実装の互換シムに差し替える（DynamoDB → Lakebase、S3 → UC Volume、Bedrock → Foundation Model API、Cognito → Databricks SSO/SCIM 等）

設計判断・ハマりどころ・再現手順は移行ナレッジを参照: [docs/databricks/源内on-Databricks_移行ナレッジ.md](../../docs/databricks/源内on-Databricks_移行ナレッジ.md)

```bash
python3 scripts/extract-routes.py > routes.json   # CDK から API ルートを抽出
npx vitest run                                    # シムのテスト
DATABRICKS_CONFIG_PROFILE=<profile> GENAI_CATALOG=<catalog> LAKEBASE_PROJECT=<project> RAG_APP_NAME=genai-qe-rag \
  ./deploy/deploy.sh                              # App 作成・リソース割り当て・ビルド・デプロイ
```
ローカル実行は `env.local.example.sh` を `.env.local.sh` にコピーして値を埋め、`node scripts/build.mjs shims lambda server && source .env.local.sh && node dist/server.cjs`。
