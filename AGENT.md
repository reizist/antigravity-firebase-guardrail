# AGENT.md — このリポジトリで作業する AI エージェントへ

非エンジニア（業務部門）が AI エージェントと一緒に社内アプリを作り、配布できる環境を、**エンジニア組織の統制（ガバナンス）を保ったまま** Firebase の上に作るリポジトリ。アプリは、1 つの共有 GCP プロジェクトの中の「テナント」（専用の Hosting サイト・Firestore DB・Functions codebase・実行 SA）として同居させる。

応答は日本語で行う。

## まず、依頼の種類を見分ける

| 依頼 | 使う Skill | 相手 |
|---|---|---|
| 「〇〇するアプリを作って」「このアプリを直して」 | [`build-firebase-app`](./.agents/skills/build-firebase-app/SKILL.md) | アプリを作りたい人（エンジニアとは限らない） |
| 「Firebase の初期環境を構築して」「基盤をセットアップして」 | [`init-firebase-platform`](./.agents/skills/init-firebase-platform/SKILL.md) | エンジニア（Google Cloud の管理者） |

どちらか分からないときは聞く。**アプリを作りたい人の依頼で、基盤（`platform/`・`scripts/`・`.github/`）を変更しない。**

## ディレクトリ構成

| パス | 持ち主 | 内容 |
|---|---|---|
| `platform/config.json` | エンジニア組織 | 環境の値（プロジェクト ID・リージョン・社内ドメイン・サイトの接頭辞・GitHub リポジトリ）。Terraform・スクリプト・CI・アプリのビルドが、この 1 か所を読む |
| `platform/catalog/apps.yaml` | エンジニア組織 | アプリ台帳（**台帳はこれ 1 つ**）。1 件追加すると、テナントが払い出される |
| `platform/terraform/bootstrap/` | エンジニア組織 | 共有 PJ・Terraform SA・tfstate バケット・WIF（最初に 1 回だけ） |
| `platform/terraform/` | エンジニア組織 | 共有 PJ の設定（API・Firebase・Auth・デプロイ SA・npm リモートリポジトリ・予算）と、`modules/app-tenant`（1 アプリ分のテナント）の for_each |
| `platform/policies/` | エンジニア組織 | CI のポリシーチェック（`pnpm policy`）と、依存の許可リスト |
| `apps/<app>/` | アプリのオーナー | 1 ディレクトリ ＝ 1 アプリ ＝ 1 テナント。`firebase.json`・`firestore.rules`・`web/`・`functions/` |
| `scripts/` | エンジニア組織 | `bootstrap_project.sh` / `deploy_platform.sh` / `deploy_app.sh` / `destroy_platform.sh` |
| `.github/` | エンジニア組織 | `ci.yml`（PR の検査）・`deploy.yml`（main から反映）・`CODEOWNERS` |
| `.agents/skills/` | エンジニア組織 | 上の 2 つの Agent Skill |
| `docs/` | エンジニア組織 | [`platform_design.md`](./docs/platform_design.md)（設計）・[`news_watcher_design.md`](./docs/news_watcher_design.md)（見本アプリ）・[`runbook.md`](./docs/runbook.md)（手順） |

## 作業ルール（全員共通）

- **アプリの名前は [`platform_design.md` §3.1](./docs/platform_design.md) に従う**：サイト `<site_prefix>-<app>`、DB `<app>`、codebase `<app>`、関数は `<appのcamelCase>-<関数名>`、実行 SA `app-<app>@`、シークレット `<APP>_<名前>`（英大文字とアンダースコア）
- **Tier 0 のアプリでは HTTP 関数（`onRequest` / `onCall`）を作らない**。画面からは Firestore に書き込むだけにし、処理は Firestore トリガーと定期実行（`onSchedule`）の関数で行う
- **Security Rules の本番への反映は、platform の Terraform だけが行う**。`apps/<app>/firestore.rules` を書き、確かめ、PR を出すところまでがアプリ側の作業。`firebase deploy` に Rules を含めない。デプロイ SA に `firebaserules.*` の反映権限を付けない
- **`(default)` データベースと既定のバケットは作らない・使わない**。Firestore は必ずアプリの名前の DB を指定する
- **秘密情報（Webhook URL など）は Secret Manager にだけ保存する**。コード・Firestore・`firebase.json`・`web/`・Git に書かない。`*.tfvars`・`*.tfstate`・`.secret.local`・サービスアカウントの鍵を commit しない
- 言語は TypeScript（Node.js 24。`.nvmrc`）。ローカルでは Firebase Emulator Suite（Java 21 以上が必要）で確かめ、**プロジェクト ID は必ず `demo-<app>`** にする（本物のプロジェクトにつながらない）
- **本番へのデプロイは GitHub Actions からだけ行う**。ローカルから `firebase deploy` しない（例外：基盤を構築するエンジニアが、デプロイ SA になりすまして行う初回の確認）
- **パッケージ管理は pnpm だけを使う**（`npm` / `npx` / `yarn` は使わない）。firebase-tools はグローバルに入れず、`pnpm exec firebase` で使う
- **依存を増やさない**。`pnpm-workspace.yaml` の `minimumReleaseAge`（7 日）・`trustPolicy`・`blockExoticSubdeps`・`strictDepBuilds`・`allowBuilds` を緩めない。依存の追加や設定の例外は、理由を書いてエンジニア組織の承認を得る（[`platform_design.md` §7.2](./docs/platform_design.md)）
- 関数は esbuild で `lib/index.js` の 1 ファイルにまとめる。`functions/package.json` の `dependencies` は `firebase-admin` と `firebase-functions` だけ（版は固定）、残りは `devDependencies`
- **クラウドのリソースを変更する操作（`terraform apply` / `destroy`・`firebase deploy`・IAM の変更）は、内容を見せてユーザーの承認を得てから行う**
- `main` に直接 push しない。作業ブランチに commit して PR を出す
- 設計を変えるときは、先に `docs/` を更新する

## 変更したら確かめる

```bash
pnpm install --frozen-lockfile
pnpm policy        # ポリシーチェック（台帳・担当範囲・HTTP 関数の禁止・Rules・依存・秘密情報）
pnpm typecheck && pnpm test && pnpm build
terraform fmt -check -recursive platform/terraform   # Terraform を変えたとき
```
