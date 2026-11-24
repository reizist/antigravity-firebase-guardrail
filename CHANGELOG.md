# Changelog

**Antigravity Firebase Guardrail** の主な変更。書式は [Keep a Changelog](https://keepachangelog.com/) におおよそ従う。
テンプレートからコピーしたリポジトリには自動では届かないので、必要な変更をここから取り込む。

## 0.1.0

- **最初の公開。** Firebase の共有プロジェクトに社内アプリをテナントとして同居させるガードレール基盤：Terraform（bootstrap・Workload Identity Federation・最小権限のデプロイ SA・`modules/app-tenant`）、アプリ台帳、環境の値を 1 か所にまとめた `platform/config.json`。
- **2 つの Agent Skill**（`.agents/skills/`）：`init-firebase-platform`（エンジニア向けの初回構築）と `build-firebase-app`（アプリを作る人向け）。
- **第 1 号アプリ `news-watcher`**：HTTP 関数を使わず、Firestore トリガーと定期実行だけで、RSS を Gemini で採点・要約して Slack に配信する。
- **CI**：ポリシーチェック（台帳・`firebase.json` の担当範囲・HTTP 関数の禁止・Rules・依存の許可リスト・秘密情報）、単体テスト、`terraform validate`、OSV-Scanner、zizmor。`deploy.yml` は `main` から WIF で反映する（Terraform は Environment の承認つき）。Dependabot が、commit SHA で固定した Action を週 1 回まとめて更新する。
- **依存の既知の脆弱性**：上流の更新待ちで、この基盤の使い方では該当しない 6 件は、理由と期限つきで `osv-scanner.toml` の例外にしている。
