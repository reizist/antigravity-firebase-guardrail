# runbook — 共有プロジェクトの構築・テナントの追加・破棄

コマンドはすべてリポジトリのルートで実行する。クラウドのリソースを変更する手順（★）は、実行前に内容（plan）を確認する。
AI エージェントに任せる場合は、Skill [`init-firebase-platform`](../.agents/skills/init-firebase-platform/SKILL.md) がこの手順を案内する。

## 0. 前提

- Google Cloud：プロジェクトを作成でき、課金アカウントを紐付けられるアカウント（組織の配下を推奨）
- 手元のツール：`gcloud`、`terraform`（1.5 以上）、Node.js 24（`.nvmrc`）、`pnpm`（`corepack enable pnpm`）
- GitHub：このリポジトリをテンプレートからコピーした、自分のリポジトリ（**業務で使うなら private にする**）

## 1. 共有プロジェクトを作る（初回だけ）

| # | 手順 |
|---|---|
| 1 | [`platform/config.json`](../platform/config.json) を自分の環境の値に書き換える（下記） |
| 2 | `apps/news-watcher/firestore.rules` の `isInternal()` のドメインと、`platform/catalog/apps.yaml` の `owners` / `admins` を書き換え、`pnpm policy` が通ることを確かめる |
| 3 ★ | `gcloud auth login` の後、`./scripts/bootstrap_project.sh` — PJ 作成・課金紐付け・Terraform SA・tfstate バケット・WIF。`platform/terraform/bootstrap/terraform.tfvars` が作られる（Git 管理外） |
| 4 | Terraform SA の借用権限が効くまで 1〜2 分待つ |
| 5 | `./scripts/deploy_platform.sh --plan` — 変更内容を確認する |
| 6 ★ | `./scripts/deploy_platform.sh` — API の有効化 → サービスエージェントの作成 → plan → 確認 → apply |
| 7 | **Google ログインを有効にする**（下記） |
| 8 | GitHub の設定（[§6](#6-github-actions-からデプロイする)） |

### platform/config.json

| キー | 内容 |
|---|---|
| `project_id` | 共有 GCP プロジェクトの ID（世界で一意） |
| `region` | Firestore・Functions・Artifact Registry のリージョン（既定 `asia-northeast1`） |
| `internal_domain` | 社内ドメイン（Google Workspace のドメイン）。Security Rules の `isInternal()` と画面のログイン制限に使う |
| `site_prefix` | Hosting サイト ID の接頭辞（サイトは `<site_prefix>-<app>`）。サイト ID は世界で一意なので、衝突したら変える。変えたら各アプリの `firebase.json` の `hosting.site` も合わせる（`pnpm policy` が確認する） |
| `github_repository` | Workload Identity Federation で受け付ける GitHub リポジトリ（`owner/repo`） |
| `deploy_ref` | SA を借用できるブランチ（既定 `refs/heads/main`） |
| `auth_handler_domain` | （任意）Firebase Auth のログイン処理を動かすドメイン。既定は `<project_id>.firebaseapp.com`（[§8](#8-ハマりどころ)） |
| `deployer_impersonators` | デプロイ SA（`fga-deployer`）にローカルからなりすませるメンバー。CI を使う前の初回デプロイ用（例: `["user:alice@example.com"]`）。業務部門は入れない |

### Google ログインの有効化

Google ログインには OAuth クライアントが必要だが、API（Terraform）からは作れない。次のどちらかで行う。

- **A. Firebase コンソールで有効化する（簡単）**：Firebase コンソール → Authentication → ログイン方法 → Google を有効にする。OAuth クライアントは自動で作られる。
  Terraform の `google_identity_platform_config` は Google プロバイダを管理していないので、apply しても元に戻らない。
- **B. Terraform で管理する**：Google Cloud コンソール → API とサービス → 認証情報で「OAuth クライアント ID（ウェブ アプリケーション）」を作り、承認済みのリダイレクト URI に `https://<project_id>.firebaseapp.com/__/auth/handler` を追加する。ID とシークレットを `platform/terraform/terraform.tfvars`（Git 管理外）の `google_oauth_client_id` / `google_oauth_client_secret` に書いて、手順 6 をもう一度実行する。CI から apply するなら、同じ値をリポジトリのシークレット `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` にも登録する（登録しないと、CI の apply が Google プロバイダの設定を消す）。

## 2. 反映後の確認

```bash
terraform -chdir=platform/terraform output -json tenants
```

- `url`（`https://<site_prefix>-news-watcher.web.app`）・`database`・`runtime_service_account`・`web_config` が出ていること
- Firebase コンソール → Firestore → DB `news-watcher` → ルール に、`apps/news-watcher/firestore.rules` の内容が反映されていること
- 台帳の `admins` に書いたメールアドレスで `members/<email>`（role = admin）ができていること
- **分離の確認**（[platform_design.md §9](./platform_design.md#9-実機で分かったこと未確認事項)）：2 つ目のテナントを作ったら、実行 SA が他のアプリの DB・関数にアクセスできないことを確かめる

## 3. テナントを追加する

1. `platform/catalog/apps.yaml` に 1 件追加する PR を出す（エンジニア組織が承認。CODEOWNERS）
2. `apps/<id>/firestore.rules` がまだなければ、全拒否の Rules が反映される
3. ★ マージすると `deploy.yml` の platform ジョブが plan を表示し、Environment `platform` の承認後に apply する（ローカルなら `./scripts/deploy_platform.sh`）

## 4. Security Rules を変更する

1. アプリ作成者が `apps/<id>/firestore.rules` を変更し、エミュレータで確かめて PR を出す
2. エンジニア組織がレビューしてマージ（CODEOWNERS）
3. ★ `deploy.yml` の platform ジョブが反映する（ローカルなら `./scripts/deploy_platform.sh`）。アプリのデプロイ SA は Rules を反映できない

## 5. アプリをデプロイする

- 通常：`main` へのマージで、変更のあったアプリだけを `deploy.yml` がデプロイする（`scripts/deploy_app.sh <app>` をデプロイ SA として実行）
- 初回や CI を使わない検証：`deployer_impersonators` に入っているエンジニアが、デプロイ SA になりすましてローカルから実行する

```bash
CLOUDSDK_CONFIG=~/.config/gcloud-fga-deployer gcloud auth application-default login \
  --impersonate-service-account=fga-deployer@<project_id>.iam.gserviceaccount.com
pnpm install --frozen-lockfile && pnpm build
./scripts/deploy_app.sh news-watcher
```

- news-watcher の配信先：台帳の `secrets` で作られたシークレット（`NEWS_WATCHER_SLACK_WEBHOOK_GENERAL`）に、オーナーが Webhook URL を登録する

```bash
printf '%s' 'https://hooks.slack.com/services/…' | gcloud secrets versions add NEWS_WATCHER_SLACK_WEBHOOK_GENERAL --data-file=- --project <project_id>
```

## 6. GitHub Actions からデプロイする

| 設定 | 内容 |
|---|---|
| リポジトリの変数 `GCP_WIF_PROVIDER` | `bootstrap_project.sh` の最後に表示される値（`projects/<番号>/locations/global/workloadIdentityPools/github/providers/github-actions`）。**未設定の間は、デプロイのジョブは何もしない** |
| Environment `platform` | Settings → Environments で作り、Required reviewers にエンジニア組織を入れる。Terraform の apply（Security Rules の反映を含む）は、plan を見た人が承認するまで実行されない |
| ブランチ保護（`main`） | PR を必須にし、「Require review from Code Owners」と CI（`ci` ワークフロー）の成功を必須にする |
| `.github/CODEOWNERS` | 雛形の所有者を、自分の組織のチーム（例: `@your-org/platform-engineers`）に書き換える |
| シークレット（任意） | Google ログインを Terraform で管理する場合の `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` |

SA を借用できるのは、`deploy_ref`（既定 `main`）で動くワークフローだけ。PR のブランチで動くワークフローは Google Cloud の認証情報を取得できない。

## 7. 破棄する

| 手順 | 内容 |
|---|---|
| ★ `./scripts/destroy_platform.sh` | テナントと共有 PJ の設定を destroy（**全アプリのデータが消える**）。firebase deploy で作った Functions・Hosting のリリースは残る |
| ★ `./scripts/destroy_platform.sh --delete-project` | さらにブートストラップを destroy して、GCP プロジェクトごと削除する |

## 8. ハマりどころ

- **サービスエージェントの作成が遅れる**：`deploy_platform.sh` が `generateServiceIdentity` を先に呼ぶ。それでも「Service agent does not exist」が出たら 1〜2 分待って再実行する
- **Terraform SA の借用が効かない**：bootstrap の直後は 1〜2 分待つ
- **Hosting のサイト ID が使われている**：サイト ID は世界で一意。`platform/config.json` の `site_prefix` を変える（Auth の許可ドメインと API キーのリファラも自動で追従する）
- **Google ログインのポップアップが `The requested action is invalid.` になる**：ログイン処理は PJ の既定ドメインで動く。プロジェクト ID に `firebase` などの予約語を含むと既定サイトの ID が変わるので（例: `firebase-xxx` → `fir-xxx`）、`platform/config.json` に `auth_handler_domain` を足して `/__/firebase/init.json` の `authDomain` を指定する
- **予算アラート**：作成には課金アカウント側の権限が要るため、既定で無効（`enable_budgets = false`）
- **最小権限の `firebase deploy` が止まる**：[platform_design.md §9](./platform_design.md#9-実機で分かったこと未確認事項) に、原因と Terraform 側の対処をまとめている
