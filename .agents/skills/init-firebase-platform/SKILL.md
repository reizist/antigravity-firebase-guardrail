---
name: init-firebase-platform
description: Firebase のガバナンス付き共有プロジェクト（ガードレール基盤）を初回構築する。Terraform・WIF・最小権限 SA・テナント払い出しを、差分を確認しながら進める
---

# init-firebase-platform — ガードレール基盤の初回構築（エンジニア向け）

エンジニア（Google Cloud の管理者）の依頼を受けて、このリポジトリのガードレール基盤を、依頼者の Google Cloud 環境に最初に 1 回だけ構築する Skill。構築するもの：

- 共有 GCP プロジェクト（Firebase）と、Terraform 用サービスアカウント・tfstate バケット
- GitHub Actions からの鍵なし認証（Workload Identity Federation）
- 最小権限のデプロイ SA（`fga-deployer`。Security Rules の反映・DB の作成・IAM の変更・シークレットの読み取りはできない）
- Artifact Registry の npm リモートリポジトリ、Functions のイメージ置き場（削除ポリシーつき）
- 台帳 `platform/catalog/apps.yaml` に載っているアプリのテナント（Hosting サイト・Firestore DB・制限付き API キー・実行 SA・シークレットの入れ物・Security Rules・最初の admin）

手順の詳細は [docs/runbook.md](../../../docs/runbook.md)、設計の理由は [docs/platform_design.md](../../../docs/platform_design.md) にある。迷ったら先に読む。

## 必須制約

- **クラウドのリソースを変更するコマンドは、内容を見せて承認を得てから実行する**。対象：`scripts/bootstrap_project.sh`、`scripts/deploy_platform.sh`（`--plan` を除く）、`scripts/deploy_app.sh`、`scripts/destroy_platform.sh`、`terraform apply` / `destroy`、`gcloud` でのリソース・IAM の変更、`gh` でのリポジトリ設定の変更。先に plan（差分）を見せる
- **`destroy` と、`google_project` の削除を含む plan は、明示的に頼まれない限り実行しない**。plan に削除（`-` や `destroy`）が出たら、止まって理由を説明する
- **秘密情報を commit しない・画面に出さない**：`*.tfvars`・`*.tfstate`・OAuth クライアントシークレット・Webhook URL・サービスアカウントの鍵。サービスアカウントの鍵は発行しない（認証は WIF とサービスアカウントの借用で行う）
- **最小権限を崩さない**：デプロイ SA に `firebaserules.*` の反映権限・`roles/editor`・`roles/owner`・プロジェクト IAM の変更権限を足さない。権限エラーが出たら、まず [docs/platform_design.md §9](../../../docs/platform_design.md) の既知の対処に当たる。ロールを足すのは、原因を説明して承認を得てから
- **サプライチェーン対策の設定を緩めない**：`pnpm-workspace.yaml` の `minimumReleaseAge`・`trustPolicy`・`blockExoticSubdeps`・`strictDepBuilds`・`allowBuilds`
- パッケージ管理は pnpm だけ（`npm` / `npx` / `yarn` を使わない）

## 進め方

### 0. 前提を確かめる

| 確かめること | 方法 |
|---|---|
| ツール | `gcloud --version`、`terraform version`（1.5 以上）、`node -v`（24。`.nvmrc`）、`pnpm -v`（`corepack enable pnpm`） |
| Google Cloud のログイン | `gcloud auth list`。プロジェクトを作成でき、課金アカウントを紐付けられるアカウントか |
| 組織・課金アカウント | `gcloud organizations list`、`gcloud billing accounts list --filter=open=true`。複数あるときは、どれを使うか聞く |
| リポジトリ | このリポジトリが、テンプレートからコピーした依頼者自身のリポジトリか（`git remote -v`）。**業務で使うなら private を勧める**（plan の出力や台帳のメールアドレスが Actions のログに出るため） |

### 1. 環境の値を決める（まだクラウドは変更しない）

依頼者に聞いて、`platform/config.json` を書き換える。

| キー | 聞くこと |
|---|---|
| `project_id` | 共有プロジェクトの ID（世界で一意。新しく作る）。既にあるプロジェクトを使うなら、表示名ではなく ID を `gcloud projects list` で確かめる（表示名と違うことが多い） |
| `region` | 既定 `asia-northeast1` |
| `internal_domain` | 社内ドメイン（Google Workspace のドメイン。このドメインのアカウントだけがアプリを使える） |
| `site_prefix` | Hosting サイトの接頭辞（既定 `fga`。サイト ID は世界で一意なので、組織名を含めた短い接頭辞を勧める） |
| `github_repository` | `owner/repo`（`git remote -v` から分かる） |
| `deployer_impersonators` | CI を設定する前に、ローカルから最初のデプロイを行うエンジニア（例: `["user:alice@example.com"]`） |

あわせて、次を同じ値にそろえる。

- `apps/news-watcher/firestore.rules` の `isInternal()` のドメイン（`.` は `[.]` と書く）
- `apps/news-watcher/firebase.json` の `hosting.site`（`<site_prefix>-news-watcher`）
- `platform/catalog/apps.yaml` の `owners`・`admins`（実在するグループ・ユーザー。存在しないメンバーは Terraform が IAM の付与で失敗する）
- `.github/CODEOWNERS` の所有者（依頼者の組織のチーム）

そろったら確かめる（どれもクラウドを変更しない）。

```bash
pnpm install --frozen-lockfile
pnpm policy            # 雛形のままの値・ドメインの不一致などを指摘する
pnpm test && pnpm build
```

### 2. ブートストラップ（★ 承認が要る）

```bash
./scripts/bootstrap_project.sh --plan   # 差分だけ（変更しない）。これを依頼者に見せる
./scripts/bootstrap_project.sh --yes    # 承認を得た後。確認の入力を求めずに apply する
```

プロジェクトの作成・課金の紐付け・Terraform SA・tfstate バケット・WIF を作る。**`--plan` の内容を依頼者に見せ、承認を得てから `--yes` で実行する**（対話の入力に答えられないエージェントは、引数なしで実行しない。引数なしだと Terraform が `yes` の入力を待って止まる）。組織・フォルダ・課金アカウント・Terraform SA を借用できるメンバーは、環境変数（`FGA_ORG_ID`・`FGA_FOLDER_ID`・`FGA_BILLING_ACCOUNT`・`FGA_OPERATORS`）で指定できる。

- 最後に表示される `GCP_WIF_PROVIDER` の値を控える（手順 5 で使う）
- Terraform SA の借用権限が効くまで 1〜2 分かかる
- 再実行で `google_project` の削除が plan に出たら、実行せずに止まる（`create_project` の設定を確かめる）

### 3. 基盤とテナントの反映（★ 承認が要る）

```bash
./scripts/deploy_platform.sh --plan    # 差分だけ（変更しない）。これを依頼者に見せる
./scripts/deploy_platform.sh --yes     # 承認を得た後。API の有効化 → サービスエージェントの作成 → plan → apply（確認の入力なし）
```

`--yes` は、直前の `--plan` を依頼者が承認したときだけ使う。apply の結果の件数（追加・変更・削除）が、見せた plan と同じであることを確かめて報告する。

よくある失敗：

| 症状 | 対処 |
|---|---|
| `Service agent does not exist` / `being provisioned` | 1〜2 分待って再実行する |
| Terraform SA の借用で 403 | bootstrap の直後。1〜2 分待つ |
| Hosting サイト ID が使われている | `site_prefix` を変え、手順 1 の「そろえる」をやり直す |
| IAM の付与で `does not exist` | 台帳の `owners` が実在しない。実在するグループ・ユーザーにする |
| 予算アラートの作成で権限エラー | 課金アカウント側の権限が要る。既定（`enable_budgets = false`）のままにする |

### 4. Google ログインを有効にする（手作業）

Google ログイン用の OAuth クライアントは API から作れないので、ここだけコンソールで行う。画面の手順を案内する。

- **簡単な方法**：Firebase コンソール → Authentication → ログイン方法 → Google を有効にする（OAuth クライアントは自動で作られる）
- Terraform で管理したい場合は [docs/runbook.md](../../../docs/runbook.md) §1 の方法 B

### 5. GitHub の設定（★ 承認が要る）

[docs/runbook.md](../../../docs/runbook.md) §6 のとおり。`gh` で行う場合も、実行前に内容を見せる。

1. リポジトリの変数 `GCP_WIF_PROVIDER` に、手順 2 で控えた値を登録する（登録するまで、デプロイのワークフローは何もしない）
2. Environment `platform` を作り、Required reviewers にエンジニア組織を入れる（Terraform の apply は、plan を見た人が承認するまで実行されない）
3. `main` のブランチ保護：PR を必須にし、「Require review from Code Owners」と `CI` ワークフローの成功を必須にする
4. ここまでの変更（`platform/config.json` など）を作業ブランチに commit し、PR を出す。`*.tfvars` と state が含まれていないことを確かめる

### 6. 最初のアプリ（news-watcher）で確かめる

1. 配信先の Webhook URL を、払い出されたシークレットに登録する（値は依頼者が自分で入力する。チャットに貼らせない）。**登録するまでデプロイできない**（関数が参照するシークレットに値がないと、`firebase deploy` が `has no latest version of the secret` で止まる）

   ```bash
   printf '%s' '<Webhook URL>' | gcloud secrets versions add NEWS_WATCHER_SLACK_WEBHOOK_GENERAL --data-file=- --project <project_id>
   ```

2. デプロイする（★）。CI を設定済みなら `main` へのマージで動く。ローカルから行うなら、`deployer_impersonators` に入っている人がデプロイ SA になりすます

   ```bash
   CLOUDSDK_CONFIG=~/.config/gcloud-fga-deployer gcloud auth application-default login \
     --impersonate-service-account=fga-deployer@<project_id>.iam.gserviceaccount.com
   pnpm build && ./scripts/deploy_app.sh news-watcher
   ```

   - なりすましのログインはブラウザでの認証が要るので、依頼者に実行してもらう
   - 端末に `firebase login` が残っていても、スクリプトは使わない（`pnpm exec firebase deploy` を直接実行しない）
   - 初回は、Firestore トリガーの関数だけ `Permission denied while using the Eventarc Service Agent` で失敗することがある。数分待って再実行する
   - 最後に「ログイン処理のドメイン」の警告が出たら、表示のとおり `platform/config.json` に `auth_handler_domain` を足して、手順 3 をやり直す（プロジェクト ID に `firebase` などの予約語を含むときに起きる）

3. `https://<site_prefix>-news-watcher.web.app` に社内アカウントでログインできること、Firebase コンソールで DB `news-watcher` の Rules が `apps/news-watcher/firestore.rules` と同じであることを確かめる
4. 監視リスト（情報源・配信先）を反映する：[docs/news_watcher_design.md](../../../docs/news_watcher_design.md) §5.1。**反映するまで、画面の配信先（「どこへ」）は空のまま**（Webhook をシークレットに登録しただけでは選べない）。先に差分（`pnpm sync:watchlist --project <project_id>`）を見せてから `--apply` する
5. 記事の取得は 60 分おき。すぐ確かめたいときは、承認を得て取得のジョブを 1 回実行し（`gcloud scheduler jobs run firebase-schedule-newsWatcher-fetchSources-<region> --location <region> --project <project_id>`）、関数のログで採点のエラー（Vertex AI の 403 など）が出ていないことを確かめる

### 7. 引き継ぐ

構築が終わったら、次を依頼者に伝える。

- アプリを作る人には、このリポジトリを開いて「〇〇するアプリを作って」と頼んでもらえばよい（Skill `build-firebase-app` が規約に沿って進める）。Google Cloud の権限も Terraform も要らない
- エンジニア組織がレビューするのは、台帳（`platform/catalog/apps.yaml`）と Security Rules（`apps/*/firestore.rules`）の差分
- まだ行っていない確認があれば、そのまま伝える（例：2 つ目のテナントを作って、他のアプリの DB にアクセスできないことの確認。[docs/platform_design.md §9](../../../docs/platform_design.md)）
