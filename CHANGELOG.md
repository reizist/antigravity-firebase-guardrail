# Changelog

**Antigravity Firebase Guardrail** の主な変更。書式は [Keep a Changelog](https://keepachangelog.com/) におおよそ従う。
テンプレートからコピーしたリポジトリには自動では届かないので、必要な変更をここから取り込む。

## Unreleased

**アプリを作るたびの承認待ちを減らす 2 つのレーンと、初回構築で入れる予算・監査のアラート。** 0.1.0 から取り込むときは [docs/runbook.md](docs/runbook.md) §8 の手順（bootstrap の再実行 → 基盤の反映）に従う。台帳には `handles_pii` と `rules_template` が必須になった。

- **2 つのレーン**：標準の型（Tier 0・個人情報なし・標準の Rules テンプレート・シークレットなし・外部への送信なし）に収まるアプリは、新しい台帳 `platform/catalog/self-service/<app>.yaml` に登録すると、レビューも承認もなしでデータベースまで払い出される。それ以外は従来どおり `platform/catalog/apps.yaml`（CODEOWNERS のレビューと、反映前の承認）。`deploy.yml` は、変わったのがセルフサービスの台帳だけで、plan の中身もそのアプリのテナントの作成・変更だけのとき（`platform/policies/plan-guard.mjs`）に限り、承認なしで apply する。
- **標準の Security Rules テンプレート**（`platform/rules-templates/`）：`internal-team-collab` と `internal-author-only`。台帳の `rules_template` で選ぶ。アプリには、エミュレータ用の写し `firestore.standard.rules` だけを置く。
- **ポリシーチェック**（`pnpm policy`）：アプリごとの判定（`AUTO_APPROVE_ELIGIBLE` / `ENGINEER_REVIEW_REQUIRED` / `BLOCKED`）を出す。台帳に `handles_pii`・`rules_template`・`external_egress`・`ttl_collections` を追加。Tier 0 での個人情報・`confidential`、アプリ数の上限（30）、`safeFetch` を通さない `fetch()`、標準テンプレートの写しの食い違いを確かめる。`ci.yml` が PR に、データの取り扱いの注意と判定をコメントする。
- **予算アラート**（`budget.tf`）：既定で作る。プロジェクト全体とアプリ別（`budget_jpy`）の予算を、Pub/Sub トピック `fga-budget-alerts` とメールに通知する。課金アカウントはプロジェクトに紐付いているものを使い、bootstrap が Terraform SA に `roles/billing.costsManager` を付ける。設定は `platform/config.json`（`enable_budgets`・`project_budget_jpy`・`budget_alert_emails`）に移した（リポジトリの変数 `ENABLE_BUDGETS` / `BILLING_ACCOUNT` は使わない）。
- **データベース作成の監査アラート**（`audit_alerts.tf`）：管理アクティビティ監査ログの `CreateDatabase` を、Pub/Sub トピック `fga-governance-alerts` とメール（`security_alert_emails`）に通知する。Terraform SA 以外が作ったときは重大として通知する。
- **TTL**：台帳の `ttl_collections` に書いたコレクションの `expiresAt` に、Terraform が TTL を設定する。
- **Skill**：`build-firebase-app` は、コードを書く前に扱うデータ（個人情報・外部への送信・保持期間・有効期限）を確かめ、レーンを決める。`init-firebase-platform` は、予算と監査のアラートの通知先を聞く。PR テンプレートに、データの取り扱いのチェックリストを追加。

初回構築を実際の環境で通したときに分かった点の改善。

- **`scripts/deploy_app.sh`**：ローカルでは、端末に残っている `firebase login` を使わない（firebase-tools は ADC より個人のログインを優先するため、デプロイ SA のなりすましが効かず、`iam.serviceAccounts.ActAs` がないという紛らわしいエラーで止まっていた）。Hosting のデプロイ後に、ログイン処理のドメイン（`/__/firebase/init.json` の `authDomain`）と `auth_handler_domain` の食い違いを確かめて、直し方を表示する。`FGA_FIREBASE_DEBUG=1` で `--debug` を付けられる。
- **`scripts/bootstrap_project.sh` / `scripts/deploy_platform.sh`**：`--yes`（確認の入力を求めない）と、bootstrap の `--plan`（差分だけ）を追加。対話の入力に答えられない AI エージェントでも、「plan を見せる → 承認 → apply」の順を守れる。サービスエージェントの作成は通信エラーで再試行し、失敗したら警告を出す。
- **news-watcher**：配信先が 1 件もないとき、配信設定の「どこへ」に理由を表示する（監視リストの反映が必要）。
- **`docs/runbook.md` §8 と Skill `init-firebase-platform`**：既存プロジェクトの ID の確かめ方、シークレットに値がないとデプロイできないこと、初回の Eventarc の反映待ち、配信先が空になる理由、取得ジョブの手動実行を追記。

## 0.1.0

- **最初の公開。** Firebase の共有プロジェクトに社内アプリをテナントとして同居させるガードレール基盤：Terraform（bootstrap・Workload Identity Federation・最小権限のデプロイ SA・`modules/app-tenant`）、アプリ台帳、環境の値を 1 か所にまとめた `platform/config.json`。
- **2 つの Agent Skill**（`.agents/skills/`）：`init-firebase-platform`（エンジニア向けの初回構築）と `build-firebase-app`（アプリを作る人向け）。
- **第 1 号アプリ `news-watcher`**：HTTP 関数を使わず、Firestore トリガーと定期実行だけで、RSS を Gemini で採点・要約して Slack に配信する。
- **CI**：ポリシーチェック（台帳・`firebase.json` の担当範囲・HTTP 関数の禁止・Rules・依存の許可リスト・秘密情報）、単体テスト、`terraform validate`、OSV-Scanner、zizmor。`deploy.yml` は `main` から WIF で反映する（Terraform は Environment の承認つき）。Dependabot が、commit SHA で固定した Action を週 1 回まとめて更新する。
- **依存の既知の脆弱性**：上流の更新待ちで、この基盤の使い方では該当しない 6 件は、理由と期限つきで `osv-scanner.toml` の例外にしている。
