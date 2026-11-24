# Changelog

**Antigravity Firebase Guardrail** の主な変更。書式は [Keep a Changelog](https://keepachangelog.com/) におおよそ従う。
テンプレートからコピーしたリポジトリには自動では届かないので、必要な変更をここから取り込む。

## 0.1.1

- **コミュニティプロジェクトとしての体裁を整えた。** ライセンスを MIT にし、ソースの著作権ヘッダーを外した。`CONTRIBUTING.md`・`SECURITY.md`・Issue テンプレート・この `CHANGELOG.md` を追加し、README に免責（Google とは無関係）を明記した。
- **GitHub Actions の保守。** Dependabot が、commit SHA で固定した Action を週 1 回まとめて更新する。zizmor がワークフローのファイルを静的に検査する（結果は Security タブ。検出があってもジョブは失敗させない）。
- **ポリシーチェックのテストが、設定を書き換えたリポジトリで失敗する問題を修正。** テストが雛形の値（`fga`・`example.com`）を決め打ちしていた。`platform/config.json` から読むようにした。
- **依存の既知の脆弱性に対応した（OSV-Scanner）。** `fast-xml-parser` 5.12.1・`hono`・`@hono/node-server`・`semver` を修正版に更新。上流の更新待ちで、この基盤の使い方では該当しない 6 件は、理由と期限つきで `osv-scanner.toml` の例外にした。

## 0.1.0

- **最初の公開。** Firebase の共有プロジェクトに社内アプリをテナントとして同居させるガードレール基盤：Terraform（bootstrap・Workload Identity Federation・最小権限のデプロイ SA・`modules/app-tenant`）、アプリ台帳、環境の値を 1 か所にまとめた `platform/config.json`。
- **2 つの Agent Skill**（`.agents/skills/`）：`init-firebase-platform`（エンジニア向けの初回構築）と `build-firebase-app`（アプリを作る人向け）。
- **第 1 号アプリ `news-watcher`**：HTTP 関数を使わず、Firestore トリガーと定期実行だけで、RSS を Gemini で採点・要約して Slack に配信する。
- **CI**：ポリシーチェック（台帳・`firebase.json` の担当範囲・HTTP 関数の禁止・Rules・依存の許可リスト・秘密情報）、単体テスト、`terraform validate`、OSV-Scanner。`deploy.yml` は `main` から WIF で反映する（Terraform は Environment の承認つき）。
