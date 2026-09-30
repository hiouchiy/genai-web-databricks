# ローカル実行用の環境変数（コピーして .env.local.sh とし、値を埋めて `source .env.local.sh`）
# .env.local.sh は .gitignore（.env.*）で除外される
export DATABRICKS_HOST=https://<workspace-host>
export DATABRICKS_CONFIG_PROFILE=<cli-profile>
export PGHOST=<lakebase-endpoint-host>            # databricks postgres list-endpoints ... の status.hosts.host
export PGDATABASE=databricks_postgres
export PGUSER=<your-email>
export PGSSLMODE=require
export LAKEBASE_ENDPOINT=projects/<project>/branches/production/endpoints/primary
export GENAI_DEV_USER_EMAIL=<your-email>          # ローカルでは X-Forwarded-Email の代わりに使う
export GENAI_DB_SCHEMA=genai_dev                  # 本番（アプリ SP 所有）の genai スキーマとは分ける
export GENAI_VOLUME_ROOT=/Volumes/<catalog>/genai/files_dev
export DATABRICKS_APP_PORT=8765
export NODE_PATH=dist/shims
