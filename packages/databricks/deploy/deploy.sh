#!/bin/bash
# 源内 Web を Databricks Apps にビルド・デプロイする。
#
# 必須の環境変数:
#   DATABRICKS_CONFIG_PROFILE  CLI プロファイル
#   GENAI_CATALOG              UC カタログ（<catalog>.genai スキーマ・files Volume を使う）
#   LAKEBASE_PROJECT           Lakebase プロジェクト ID
#   RAG_APP_NAME               AI アプリ（クエリ拡張 RAG）の App 名（App→App 呼び出しの権限付与用）
# 任意:
#   GENAI_APP_NAME             App 名（既定: genai-web）
#   WORKSPACE_DIR              ソースのアップロード先（既定: /Workspace/Users/<me>/apps/<App 名>）
#   SKIP_RESOURCES=1           リソース割り当てを省略（2 回目以降のデプロイ）
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABRICKS_CONFIG_PROFILE:?}" "${GENAI_CATALOG:?}" "${LAKEBASE_PROJECT:?}" "${RAG_APP_NAME:?}"
APP=${GENAI_APP_NAME:-genai-web}
P=(--profile "$DATABRICKS_CONFIG_PROFILE")

# 1. App が無ければ作成（URL を確定させるため先に作る：SPA のビルドに必要）
if ! databricks apps get "$APP" "${P[@]}" >/dev/null 2>&1; then
  databricks apps create "$APP" --description "源内 Web on Databricks" "${P[@]}" >/dev/null
fi
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }
until [[ "$(databricks apps get "$APP" "${P[@]}" -o json | json "d.get('compute_status',{}).get('state')")" =~ ^(ACTIVE|STOPPED)$ ]]; do sleep 10; done
export GENAI_APP_URL=$(databricks apps get "$APP" "${P[@]}" -o json | json "d['url']")
export LAKEBASE_ENDPOINT=projects/${LAKEBASE_PROJECT}/branches/production/endpoints/primary

# 2. リソース（Lakebase・FMAPI・Volume・RAG App・シークレット）とユーザー認可スコープを割り当て
if [[ -z "${SKIP_RESOURCES:-}" ]]; then
  node -e 'const fs=require("fs");process.stdout.write(fs.readFileSync(process.argv[1],"utf8").replace(/\$\{(\w+)\}/g,(m,k)=>{if(!process.env[k])throw new Error(k);return process.env[k]}))' \
    deploy/app-resources.tmpl.json > /tmp/genai-web-resources.json
  databricks apps create-update "$APP" --json @/tmp/genai-web-resources.json "${P[@]}" >/dev/null
fi

# 3. ビルド → アップロード → デプロイ
node scripts/build.mjs
ME=$(databricks current-user me "${P[@]}" -o json | json "d['userName']")
W=${WORKSPACE_DIR:-/Workspace/Users/$ME/apps/$APP}
databricks sync dist "$W" --full "${P[@]}"
databricks apps deploy "$APP" --source-code-path "$W" "${P[@]}"
echo "deployed: $GENAI_APP_URL"
