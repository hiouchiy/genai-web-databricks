# 源内（GENAI）on Databricks — 移行ナレッジ

最終更新: 2026-09-30

> 本リポジトリはデジタル庁の公式リポジトリではなく、Databricks 上での動作検証のための非公式フォークです。

デジタル庁の生成 AI 基盤「源内」（[genai-web](https://github.com/digital-go-jp/genai-web) / [genai-ai-api](https://github.com/digital-go-jp/genai-ai-api)）を Databricks 上でホストした動作検証の記録。
「何を作ったか」だけでなく、**なぜその設計にしたか・どこでハマったか・後続者が同じ轍を踏まないためのポイント**をすべて残す。

---

## 0. サマリー

| 項目 | 内容 |
|---|---|
| 目的 | 源内が Databricks 上で動作するかの技術検証 |
| 結論 | **載る。** 源内 Web 本体 + AI アプリ（クエリ拡張 RAG）が Databricks Apps 上で動作し、源内 Web → RAG → Vector Search / Claude までエンドツーエンドで確認済み |
| 方針 | **元コード無改変（互換シム方式）**。genai-web の `packages/cdk/lambda`・`packages/web`、genai-ai-api の `aws/` は 1 行も変更していない |
| 検証環境 | Databricks on AWS（ap-northeast-1）の検証用ワークスペース、Databricks Apps × 2（源内 Web / クエリ拡張 RAG） |
| リポジトリ | [genai-web-databricks](https://github.com/hiouchiy/genai-web-databricks)（本書・源内 Web）／ [genai-ai-api-databricks](https://github.com/hiouchiy/genai-ai-api-databricks)（RAG） |
| 構成図 | [現行 AWS](images/architecture_aws.png)（Databricks 側の対応は 1.3 の表を参照） |

### 実測値（2026-09-30）
| 計測 | 値 |
|---|---|
| RAG 単体（ローカル → ワークスペース） | 約 25 秒 |
| RAG 単体（Databricks Apps 上） | 約 27 秒 |
| 源内 Web 経由の AI アプリ実行（App → App） | 約 35 秒 |
| RAG コーパス | デジタル庁公開 PDF 25 文書 → 1,823 チャンク（平均 744 字） |
| RAG 1 回あたりの LLM 呼び出し | Haiku 4.5 × 4（クエリ拡張 1 + 関連度評価 3）、Sonnet 4.6 × 1（回答生成） |

---

## 1. まず構造を押さえる（誰が何を持っているか）

### 1.1 2 つのリポジトリの関係
```
[行政職員のブラウザ]
      │
      ▼
genai-web（源内本体）… チャット / チーム管理 / AI アプリ管理・実行。AWS の OSS「GenU」のフォーク
      │  POST {inputs:{...}}   ヘッダ: x-api-key, x-user-id
      │  ← 200 {outputs} ／ 202 {status_url}（非同期はポーリング）
      ▼
genai-ai-api（AI アプリ群）… 源内とは疎結合な外部マイクロサービス。共通 API 契約さえ守ればどこで動いてもよい
      ├ aws/query-expansion-rag      … クエリ拡張 RAG（Bedrock KB + Claude Haiku）  ← 今回移植
      ├ azure/genai-azure            … vLLM で PLaMo-2-translate を GPU VMSS 上に自前サービング、Azure OpenAI 等
      └ google-cloud/lawsy-custom-bq … 法令調査（BigQuery ベクトル検索 + Gemini Web グラウンディング）
```
**ポイント**: AI アプリは「共通契約の HTTP エンドポイント」でしかないので、本体より移行が圧倒的に容易。本体側は AWS マネージドサービスに密結合。

### 1.2 源内 Web（AWS）の構成要素
| 層 | AWS | 役割 |
|---|---|---|
| 配信 | S3 + CloudFront + WAF | React 19 / Vite の SPA |
| 認証 | Cognito User Pool（+SAML, メール MFA via SES）+ Identity Pool | ログイン、グループ（SystemAdmin / TeamAdmin / User）、ブラウザ用の一時 AWS 資格情報 |
| API | API Gateway × 2（メイン / チーム・AI アプリ管理）+ Lambda（Node, 43 関数・41 ルート） | ビジネスロジック |
| ストリーミング | ブラウザ → Lambda を **直接** `InvokeWithResponseStream`（Identity Pool 資格情報） | チャットのトークン逐次表示 |
| データ | DynamoDB 5 テーブル、S3（添付・成果物）、Secrets Manager（AI アプリ API キー）、KMS | |
| LLM | Bedrock Converse（Claude / Nova）、Guardrails、Transcribe | |
| 非同期 | SQS → pollExAppStatus Lambda | 202 を返す AI アプリの状態ポーリング |

### 1.3 Databricks 上の対応
| 源内の要素 | Databricks | 実装箇所 |
|---|---|---|
| SPA + API Gateway + Lambda 群 | **Databricks App 1 つ（Node/Express）**。元の Lambda を 1 関数 1 バンドルでロードして呼ぶ | `packages/databricks/src/server/` |
| Lambda ストリーミング | App の `/api/predict-stream`（チャンク転送） | `server/main.ts`, `web/shims/client-lambda.ts` |
| Cognito | **Apps の SSO**（`X-Forwarded-Email`）＋ SCIM ＋ Lakebase のグループ表 | `runtime/identity.ts` |
| DynamoDB | **Lakebase（Postgres）** に `(pk_val, sk_val, item jsonb)` 形式で格納 | `shims/_dynamo/` |
| S3 | **UC Volume**（Files API）、署名付き URL は HMAC 署名で自前検証 | `runtime/files.ts` |
| Bedrock | **Foundation Model API**（OpenAI 互換） | `shims/@aws-sdk/client-bedrock-runtime/` |
| Secrets Manager | Lakebase（AES-256-GCM 暗号化、鍵は Databricks Secrets） | `runtime/secrets.ts` |
| SQS | アプリ内キュー（メモリ） | `runtime/queue.ts` |
| KMS GenerateMac | HMAC-SHA256（鍵は Databricks Secrets） | `shims/@aws-sdk/client-kms` |
| CloudWatch | 標準出力（Apps ログ） | `shims/@aws-sdk/client-cloudwatch` |
| RAG: Bedrock KB（OpenSearch + Titan Embed） | **Vector Search**（Delta Sync, Qwen3-Embedding）+ `ai_parse_document` | `genai-ai-api/databricks/query-expansion-rag/` |


---

## 2. 基本方針と、その判断理由

### 2.1 「元コード無改変・互換シム」方式を選んだ理由
- **差分の明快さ**: 既存コードへの変更がないため、移植に必要な作業が追加フォルダだけに閉じ、本家との差分で一目で確認できる。
- **追従性**: 源内は活発に更新されている。フォークを書き換えると upstream の更新を取り込めなくなる。シムならば upstream を pull してビルドし直すだけ。
- **調べてみると AWS 依存が局所化していた**: リポジトリ層（DynamoDB）約 1,650 行、Bedrock 呼び出し約 350 行、フロントの Amplify 依存 8 ファイル。ハンドラ本体のビジネスロジックは純粋。
- **見積もりは依存の「広さ」ではなく「集中度」で判断する。** AWS サービスを多数使っていても、呼び出し箇所が少数のモジュールに集約されていれば、そこを差し替えるだけで済む。

### 2.2 シムの差し込み方（最重要アーキテクチャ判断）
```
dist/
├ server.cjs                        … Express。routes.json に従い Lambda を呼ぶ
├ lambda/<関数名>.cjs                … packages/cdk/lambda/*.ts を esbuild で「1 関数 = 1 バンドル」
├ shims/@aws-sdk/<pkg>/index.js      … AWS SDK 互換シム（esbuild の external にして実行時解決）
├ shims/genai-dbx-runtime/index.js   … シム間で共有するシングルトン（DB プール・トークン等）
└ web/                               … packages/web を Vite alias でシム差し替えしてビルド
```
- **なぜ 1 関数 1 バンドルか**: Lambda ごとに環境変数が違う。特に **`TABLE_NAME` はメイン API ではチャット用テーブル、チーム管理 API ではチーム用テーブル**を指す（CDK を読まないと気づけない）。しかも `export const TABLE_NAME = process.env.TABLE_NAME` とモジュール評価時に読まれる。→ ロード中だけ env を上書きして require することで「Lambda と同じ条件」を再現（`server/lambdaHost.ts`）。
- **なぜシムを external にするか**: 全バンドルで同じシム実体（= 同じ Lakebase 接続プール、同じトークンキャッシュ）を共有するため。バンドルに内包すると 43 個のプールができる。
- **共有状態は `genai-dbx-runtime` 経由のみ**。シムから `src/runtime` を相対 import すると別インスタンスになるので禁止。

---

## 3. 源内 Web 移植のハマりどころ（時系列ではなくテーマ別）

### 3.1 モジュール解決
- ❌ `NODE_PATH` だけでは不十分。**Node は node_modules を NODE_PATH より優先する**ため、モノレポ内（ローカル）で実行すると本物の `@aws-sdk/*` が解決され、実 AWS に `AccessDeniedException` を出した。
- ✅ `Module._resolveFilename` をフックし、`@aws-sdk/*` と `genai-dbx-runtime` を必ず `dist/shims` に向ける。シムが無いパッケージは即エラーにする（黙って本物に落ちない）。
- `packages/databricks/package.json` が `"type": "module"` なので、`dist/shims/*.js`（CJS）が ESM 扱いされて落ちた → `dist/shims/package.json` に `{"type":"commonjs"}` を置く。
- **シムの漏れ検出**: ビルド後に各 Lambda バンドル内の `import_client_xxx.Symbol` を抽出し、シムが実体をエクスポートしているか照合する。これで **`ConversationRole` が型ではなく値（enum）として使われている**ことを発見（型だけ re-export していたため実行時に `undefined.USER`）。

### 3.2 ルーティングの自動抽出
- API のルート（メソッド・パス・ハンドラ）は CDK（`lib/construct/api.ts`, `team-access-control.ts`）から `scripts/extract-routes.py` で `routes.json` を生成。手書きしない（upstream 追従のため）。
- 落とし穴: `new LambdaIntegration(fn, { timeout: ... })` と**オプション付き・複数行**の書き方があり、最初の正規表現では `/exapps/invoke` 等 3 本を取りこぼした。**抽出後は件数（41）と CDK の addMethod 数を突き合わせること。**
- SQS 起動の `pollExAppStatus` と、Lambda URL 直呼びの `predictStream` は API Gateway 外なので別扱い。

### 3.3 API Gateway イベントの再現（`server/event.ts`）
- ハンドラは `event.requestContext.authorizer.claims['sub' | 'email' | 'cognito:groups']` を読む。ここを Databricks ユーザーで埋める。`sub` = Databricks の SCIM ユーザー ID。
- `cognito:groups` は **カンマ区切り文字列**（配列ではない）。
- ファイル所有者チェックは「S3 キーの先頭 = Cognito Identity ID」で行われ、Identity ID は `Authorization: Bearer <idToken>` から `GetId` で解決される。→ サーバが `Authorization: Bearer dbx:<userId>` を合成し、Cognito Identity シムが `dbx-<userId>` を返す。**元の IDOR 対策ロジックがそのまま機能する。**
- ストリーミング Lambda は `awslambda.streamifyResponse` というランタイム提供のグローバルに依存 → ロード前にグローバルを定義（素通し）。`context.identity.cognitoIdentityId` も渡す。

### 3.4 DynamoDB → Lakebase シム（`shims/_dynamo/`）
- 使われていたのは Put / Get / Query / Update / Delete / BatchWrite / BatchGet / TransactWrite。式は KeyCondition（`=`, `begins_with`, 比較, BETWEEN）、Filter（`contains` 等）、Condition（`attribute_(not_)exists`）、Update（`SET`, `if_not_exists(a,:z) + :one`, REMOVE/ADD）。**正規表現ではなくトークナイザ＋パーサで実装**（将来の式追加に耐える）。
- 格納: テーブルごとに `(pk_val, sk_val, item jsonb)`。Query はパーティションキー等価で SQL 絞り込み → 残りの条件・ソート・ページングは JS 評価（小規模データ前提）。
- DynamoDB の意味論で注意: **`Limit` はフィルタ前に適用**、`LastEvaluatedKey` には GSI キーも含める、`ScanIndexForward`、数値と文字列の型保持。
- ❌ 当初、キースキーマのレジストリを `process.env.TABLE_NAME` から一度だけ組み立ててキャッシュしていた → バンドルごとに TABLE_NAME が違うので破綻。✅ **テーブル名そのもの（`genai_chat`, `genai_team` …）をキーにした静的レジストリ**に変更。
- GSI: チームテーブルの `GSI-1`（sk, pk の逆引き）でチーム一覧、チャットテーブルの `FeedbackIndex`、パスワードリセットの `EmailHashIndex`。
- TTL（`expire_at`）は未実装（削除ジョブが必要なら Lakeflow Jobs で）。

### 3.5 Bedrock → FMAPI シム
- Converse の messages/system/inferenceConfig → OpenAI Chat Completions に変換。モデル ID は正規表現で対応付け（`claude-sonnet-4-6` → `databricks-claude-sonnet-4-6`、`haiku-4-5`、Nova → Haiku 等）。上書きは `DATABRICKS_MODEL_MAP`。
- ストリーミング: FMAPI の SSE を Bedrock の `messageStart → contentBlockDelta* → contentBlockStop → messageStop → metadata` に変換。
  - ❌ 当初 FMAPI がチャンクごとに usage を返すのをそのまま `metadata` として毎回出していた（フロントに使用量行が大量に出る）。✅ **最後の usage を保持し、終端で 1 回だけ** metadata を出す（Bedrock と同じ順序）。
- **Databricks Apps のプロキシは SSE/チャンク応答をバッファせず、トークン逐次で届いた**（ドキュメント上は「バッファされることがある」とされるので、環境が変わったら要再確認）。
- 未対応: PDF 添付の本文（ファイル名プレースホルダ化）、プロンプトキャッシュ、Bedrock Guardrails（→ AI Gateway のガードレールで代替検討）、画像生成。

### 3.6 S3 → UC Volume と署名付き URL
- **フロントもバックエンドも S3 の URL 形式を正規表現でハードコード**している（`https://<bucket>.s3.<region>.amazonaws.com/<key>` からバケット・キーを抽出、`createMessages` はホスト名を厳格検証）。
- → アップロード用（PUT）の署名付き URL は **あえて amazonaws 形式のまま発行**し、ブラウザ側シムの fetch フックが同一オリジンの `/_s3/<bucket>/<key>` に付け替える。サーバが HMAC 署名を検証して Volume に書く。
- ダウンロード用（GET）は `<img src>` 等にそのまま使われ fetch を通らないので、**相対パス `/_s3/...` で返す**（パースされていないことを確認済み）。
- Volume パス: `/Volumes/<catalog>/genai/files/<bucket>/<key>`。キーに日本語ファイル名が入るので Files API のパスはセグメントごとに URL エンコード。

### 3.7 認証・ユーザー管理（Cognito → Databricks）
- ブラウザは Apps の SSO Cookie で認証済み。サーバは `X-Forwarded-Email` でユーザーを特定し、SCIM で ID を解決して Lakebase の `users` に記録。
- **フロントの fetcher は Cognito の ID トークンを `Authorization` ヘッダに付ける**。これを Apps のプロキシに送ると Databricks トークンとして扱われる恐れがあるので、ブラウザ側 fetch フックで**同一オリジン宛ての Authorization を除去**。
- 源内のグループ: `UserGroup` は全員、`SystemAdminGroup` は Databricks の `admins` 所属者、`TeamAdminGroup` は元コードどおり Cognito の AdminAddUserToGroup 経由 → シムが Lakebase の `user_groups` に書く。
- ❌ **アプリの SP で SCIM を引くと他ユーザーの所属グループが返らない**（ローカルでは自分の権限なので返っていて気づかなかった）。✅ Apps の**ユーザー認可（OBO）**でユーザー本人のトークン（`x-forwarded-access-token`）を受け取り、`/scim/v2/Me` で本人の groups を取得。
- ❌ `user_api_scopes` に `iam.current-user:read` を指定すると「invalid scope」。これは**既定スコープで明示指定できない**。✅ 何か 1 つスコープ（今回 `files.files`）を宣言すると、`effective_user_api_scopes` に既定の `iam.current-user:read` / `iam.access-control:read` が付いてくる。
- Amplify のシム: `fetchAuthSession()` は `/api/me` を叩いて Cognito セッション風の形（`tokens.idToken.toString()`, `accessToken.payload['cognito:groups']`）を返す。`<Authenticator>` は子要素を素通し、`useAuthenticator` は常に authenticated。
- スコープ外にしたもの: 自己サインアップ、パスワードリセット、メール MFA、SAML（すべて Databricks アカウント側の SSO に集約）。本番化では「Cognito を捨てて Databricks SSO（庁内 IdP 連携）に寄せる」か「Cognito と連携する」かの判断が必要。

### 3.8 AI アプリ呼び出し（App → App）
- Databricks App は **Databricks OAuth トークンが無いと呼べない**（無いとログイン画面への 302）。源内の `invokeExApp` は `x-api-key` しか付けない。
- ✅ サーバの `globalThis.fetch` をフックし、宛先が `*.databricksapps.com` のときだけ **App の SP の OAuth トークンを Authorization に付与**。元コードの `x-api-key` / `x-user-id` はそのまま → RAG 側で API キーも検証（二重防御）。
- 源内 Web App に `app` リソース（`genai-qe-rag`, `CAN_USE`）を宣言して SP に権限付与。
- タイムアウト: AWS では API Gateway / Lambda（既定 29 秒, `exAppInvokeTimeoutSeconds`）で決まっていた。Databricks では **Apps プロキシの 120 秒上限**。RAG は約 27〜35 秒なので問題なし。長時間処理は元の非同期（202 + status_url）の仕組みを使う。

### 3.9 Lakebase
- `@databricks/lakebase` の `createLakebasePool()` が OAuth トークン取得・更新・SSL を面倒見てくれる。Apps の `postgres` リソースで `PGHOST` 等が入る。`LAKEBASE_ENDPOINT` は app.yaml で明示した。
- **スキーマはアプリの SP が作成・所有する必要がある**。ローカル開発で先に同名スキーマを作ると SP が触れなくなる → ローカルは `GENAI_DB_SCHEMA=genai_dev`、本番は `genai`（SP が初回起動時に作成）。
- ローカル実行時の Volume も `files_dev` に分けた。

### 3.10 Databricks Apps のデプロイ運用
- **node_modules は持ち込まない**: サーバ・シム・Lambda を esbuild で全部バンドル。`dist/` に package.json を置かないので Apps は依存インストールをスキップし即起動（デプロイ約 50 秒）。1 ファイル 10MB 上限にも余裕。
- SPA は Vite ビルド時に API の絶対 URL（`VITE_APP_API_ENDPOINT`）が必要 → **先に `apps create` して URL を確定させてからビルド**。
- `apps create-update` は **コンピュートが ACTIVE か STOPPED のときしか受け付けない**（作成直後の STARTING 中はエラー）。
- `update_mask=resources` は配列を丸ごと置き換える（マージされない）。
- Express 5 のワイルドカードは `/*path` だと `/` にマッチしない → `/{*path}`。
- `app.yaml` の `command` 配列内の `$DATABRICKS_APP_PORT` はシェル展開されない前提で書く（Python はコード内で env を読む）。
- シークレットは `genai` スコープ（`secrets-key`, `url-signing-key`, `user-id-hmac-key`, `rag-api-key`）を `secret` リソースで注入。

---

## 4. RAG（aws/query-expansion-rag）移植のポイント

### 4.1 無改変で動かす仕組み
- `sync_vendor.sh` で元の Lambda コードを `vendor/invokeModel/` に**コピー**（CDK バンドル時と同様に、プロジェクト直下の `config/defaults`, `config/apps` を `invokeModel/config/` 配下へ）。
- 元コードは `services/aws_clients.py` の `bedrock_runtime` / `bedrock_agent_runtime`（boto3）だけを使う。→ **`sys.modules["services.aws_clients"] = dbx_clients` を import 前に差し込む**だけで差し替え完了。boto3 は不要。
- 元の `app.py` はファイル名が衝突しやすいので `importlib` で `lambda_app` という名前でロードし、`handler(event, None)` をそのまま呼ぶ。HTTP 層（FastAPI）は `POST /invoke` と `x-api-key` 検証のみ。

### 4.2 Python ランタイム差分
- **元コードは Lambda Python 3.14 前提**（アノテーション遅延評価）。未 import の `BedrockUsageTracker` を型注釈に使っており、3.11〜3.13 では import 時に NameError。→ サーバ側で `builtins.BedrockUsageTracker` を先に置く互換処理（元コード無改変）。
- `importlib` でモジュールをロードする際、**`sys.modules` に登録してから exec しないと dataclass が落ちる**。
- `aws_lambda_powertools` は Lambda 外でも動く。ただし `Tracer` のために **`aws_xray_sdk` が import 時に必要**（トレース無効でも）。
- 元コードはモデル ARN 組み立てで **`AWS_ACCOUNT_ID` を必須**にしている（Nova 等の推論プロファイル）→ ダミー値を設定。
- 失敗は `handleException` でログに出るだけで**HTTP は 200 のまま「context が空です」という回答になる**。応答だけ見て成功と判断しないこと（ログの `Exception Occurred` を必ず確認）。

### 4.3 Bedrock KB → Vector Search の意味論差
- 元コードは `retrieve` ではなく **`retrieve_and_generate`** を呼び、返ってくる `citations[].generatedResponsePart.text`（KB が生成した抜粋）を関連度評価の入力に使う。
- 今回は Vector Search（HYBRID）で取得したチャンク本文を citations として返す実装（生成ステップを省略）。レイテンシ・コスト面で有利で、回答品質も良好だったが、**厳密には元の挙動と異なる**点に留意。
- メタデータフィルタ（`equals` / `orAll` の `tags`）は Vector Search の `filters_json`（`{"tags": [...]}`）に変換。
- 引用は `metadata.file_name`（文書名）・`url`・`x-amz-bedrock-kb-document-page-number` を元コードが読む → ページ番号付きで原文 PDF にリンクされる。

### 4.4 設定だけで振る舞いを変える
- 元の設計どおり `config/apps/<app>.toml` を追加（`digital_agency.toml`）し、システムプロンプトとモデル（`databricks-claude-haiku-4-5` / `databricks-claude-sonnet-4-6`）を指定。コードを変えずに設定だけで Databricks のモデルを選べる。

---

## 5. データ取り込み（デジタル庁公開 PDF）

- 出典: https://www.digital.go.jp/resources/standard_guidelines と生成 AI ガイドブックのページから PDF を収集。**リンク文字列の多くが「本文（PDF／…KB）」なので、直前の見出し（h2〜h4）を文書名として採用**。
- 全件 `curl` で HTTP 200 と先頭 `%PDF-` を検証してから Volume（`/Volumes/.../genai/docs/digital_agency/`）へ。`sources.csv` に文書名・URL・タグ。
- パイプライン（`genai-ai-api/databricks/query-expansion-rag/ingest/`）
  1. `01_parse.sql`: `ai_parse_document(content, map('version','2.0'))` → `genai.qe_rag_parsed`（25 文書、エラー 0）
  2. `02_chunk.sql`: ページ単位に要素を連結（ヘッダ・フッタ・ページ番号要素は除外）→ 1,000 字窓 + 200 字オーバーラップ → `genai.qe_rag_chunks`（CDF 有効、1,823 行）。埋め込み用に `【文書名】（nページ）` を前置した `embed_text` 列を別に持つ。
  3. `03_index.json`: Delta Sync インデックス `genai.qe_rag_chunks_index`（TRIGGERED、埋め込み `databricks-qwen3-embedding-0-6b`）。
- **`ai_prep_search` はこのワークスペースではプレビュー未有効**（`AI Prep Search Preview is not enabled`）→ SQL で自前チャンク。有効な環境では置き換えた方が良い。
- 日本語コーパスなので埋め込みは多言語の Qwen3-Embedding を選択（gte/bge-large-en は英語向け）。
- Vector Search エンドポイントが ONLINE でも、インデックス作成直後はしばらく `pending endpoint provisioning` のまま進まない時間があった。待つしかない。
- SQL は Statement Execution API に `wait_timeout: 0s` で投げてポーリング（長時間の `ai_parse_document` に対応）。

---

## 6. 環境・ツールの落とし穴

| 事象 | 対処 |
|---|---|
| `databricks auth token --profile X` は**トークン文字列ではなく JSON**を返す | `access_token` を取り出す。毎回 CLI を起動しないようキャッシュ |
| Apps 上の SP 権限とローカル（自分の権限）で結果が違う（SCIM の groups 等） | **ローカルで動いても本番で必ず再確認**。本番で `/api/me` を叩いて確認するのが早い |

---

## 7. 既知の制約

| 項目 | 現状 |
|---|---|
| 認証 | Databricks SSO + ワークスペースユーザーのみ。Cognito の自己サインアップ・パスワードリセット・メール MFA・SAML は非対応 |
| 非同期キュー | メモリ上で保持（App 再起動で処理中のポーリングは失われる） |
| TTL | DynamoDB の TTL（期限切れデータの自動削除）は未実装 |
| スケール | App 1 インスタンス想定。Query のフィルタ・ソートは JS 側で評価（小規模データ前提） |
| ガードレール | Bedrock Guardrails の設定は無視される |
| 監査・監視 | CloudWatch メトリクスは標準出力へのログ出力に置き換え |
| コスト表示 | 元コードの Bedrock 単価表のまま計算される |
| RAG | `retrieve_and_generate` の生成ステップは省略（検索結果をそのまま引用として返す）。短く一般的な質問では関連チャンクが上位に来ないことがある |
| 未移植 | 画像生成、音声文字起こし、PDF 添付の本文読み取り、プロンプトキャッシュ |

---

## 8. 再現手順

ワークスペース固有の値（カタログ名・Lakebase プロジェクト・App 名）はリポジトリに持たず、環境変数で渡す。テンプレート（`*.tmpl`）の変数をスクリプトが置換する。

### 8.1 事前に用意するリソース
```bash
P=<cli-profile>; C=<catalog>
databricks schemas create genai $C --profile $P
for v in docs files files_dev; do databricks volumes create $C genai $v MANAGED --profile $P; done
databricks postgres create-project <lakebase-project> --json '{"spec": {"display_name": "GENAI"}}' --profile $P
databricks vector-search-endpoints create-endpoint <vs-endpoint> STANDARD --profile $P
databricks secrets create-scope genai --profile $P
for k in secrets-key url-signing-key user-id-hmac-key rag-api-key; do
  databricks secrets put-secret genai $k --string-value "$(openssl rand -hex 32)" --profile $P
done
```

### 8.2 RAG（genai-ai-api-databricks）
```bash
cd databricks/query-expansion-rag
# 取り込み: PDF 取得 → Volume → ai_parse_document → チャンク → Vector Search
DATABRICKS_CONFIG_PROFILE=$P GENAI_CATALOG=$C WAREHOUSE_ID=<warehouse-id> VS_ENDPOINT=<vs-endpoint> ./ingest/run_ingest.sh
# デプロイ（App 作成・リソース割り当て・元コードの vendor コピー・app.yaml 生成まで行う）
DATABRICKS_CONFIG_PROFILE=$P GENAI_CATALOG=$C ./deploy.sh
```
ローカル実行: `uv venv -p 3.11 .venv && uv pip install -p .venv -r requirements.txt && ./sync_vendor.sh` → `DATABRICKS_CONFIG_PROFILE=$P VS_INDEX=$C.genai.qe_rag_chunks_index API_KEY=local-test .venv/bin/python server.py`

### 8.3 源内 Web（genai-web-databricks）
```bash
npm install --engine-strict=false            # engines は Node 24 指定だが 22 でも動作
cd packages/databricks
python3 scripts/extract-routes.py > routes.json   # upstream 更新時に CDK からルート再抽出
npx vitest run                                    # シムのテスト
DATABRICKS_CONFIG_PROFILE=$P GENAI_CATALOG=$C LAKEBASE_PROJECT=<lakebase-project> RAG_APP_NAME=genai-qe-rag ./deploy/deploy.sh
```
`deploy.sh` は App 作成（URL 確定）→ リソース・ユーザー認可スコープ割り当て → ビルド（SPA に App URL を埋め込む）→ アップロード → デプロイを行う。2 回目以降は `SKIP_RESOURCES=1` で高速化。
ローカル実行: `env.local.example.sh` を `.env.local.sh` にコピーして値を埋め、`node scripts/build.mjs shims lambda server && source .env.local.sh && node dist/server.cjs`。

### 8.4 源内 Web への AI アプリ登録
システム管理者（ワークスペース admins）で源内 Web にログイン → チーム作成 → 「アプリの作成」で登録。
- エンドポイント: `https://<rag-app-url>/invoke`
- API キー: シークレット `genai/rag-api-key` の値
- フォーム定義（placeholder）の例:
```json
{
  "question": { "type": "textarea", "title": "質問", "required": true, "max_length": 2000 },
  "n_queries": { "type": "number", "title": "クエリ拡張数", "min": 1, "max": 5, "default_value": "3" },
  "output_in_detail": { "type": "checkbox", "title": "詳細回答", "items": [{ "title": "詳しく回答する", "value": "true" }] }
}
```

### 8.5 upstream（デジタル庁の本家）への追従
```bash
git fetch upstream && git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout databricks && git merge main           # 追加フォルダのみなので基本的に衝突しない
python3 packages/databricks/scripts/extract-routes.py > packages/databricks/routes.json   # ルート追加に追従
cd packages/databricks && npx vitest run && node scripts/build.mjs shims lambda server    # シム漏れ警告を確認
```

## 9. ファイルマップ

```
genai-web-databricks/  (default branch: databricks, main = upstream 追従)
├ docs/databricks/                            … 本書と構成図
└ packages/databricks/                        … 追加パッケージ（既存コードは無改変）
   ├ src/server/{main,lambdaHost,event,config}.ts
   ├ src/runtime/{db,databricksAuth,identity,files,secrets,queue}.ts
   ├ src/shims/@aws-sdk/*                     … 18 パッケージ分の互換シム
   ├ src/shims/_dynamo/*                      … DynamoDB 式パーサ・評価器・Postgres ストア
   ├ web/shims/*, web/vite.databricks.config.ts … ブラウザ側シムと Vite 設定
   ├ scripts/{extract-routes.py,build.mjs}, routes.json, app.yaml.tmpl
   ├ deploy/{deploy.sh,app-resources.tmpl.json}, env.local.example.sh
   └ tests/{dynamo,bedrock}.test.ts

genai-ai-api-databricks/  (default branch: databricks)
└ databricks/query-expansion-rag/
   ├ server.py, dbx_clients.py, sync_vendor.sh, deploy.sh, app.yaml.tmpl, requirements.txt
   ├ config/apps/digital_agency.toml
   ├ deploy/app-resources.tmpl.json
   └ ingest/{run_ingest.sh,01_parse.sql,02_chunk.sql,03_index.json,sources.csv}
```
