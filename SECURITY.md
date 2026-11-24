# Security policy

これはコミュニティプロジェクトです（MIT。Google とは無関係です）。Google Cloud の IAM・Security Rules・デプロイの経路を扱うので、セキュリティに関する報告は本当に助かります。

## 脆弱性の報告

**推奨：** GitHub の非公開の脆弱性報告を使ってください —
このリポジトリの **Security → Report a vulnerability**
（https://github.com/reizist/antigravity-firebase-guardrail/security/advisories/new）。
修正が出るまで、内容は非公開のまま扱えます。

使えない場合は、影響と、壊さない再現手順を書いた通常の Issue を開き、非公開でやり取りしたい旨を書いてください。メンテナーから連絡します。

含めてほしいもの：対象のファイル・commit、影響（悪意のある入力や PR で何ができるか）、**実際のリソースを壊さない** 再現手順（自分の検証用プロジェクトかエミュレータで確かめたもの）。

## 対象 — 特に重要なところ

このリポジトリは「AI の出力がぶれても、仕組みの側で止まる」ことを狙っています。**その境界を越えられる方法** が、最も価値のある報告です。

- **テナントの分離**（[`platform/terraform/modules/app-tenant/`](platform/terraform/modules/app-tenant/)）— あるアプリの実行 SA・オーナーが、他のアプリの Firestore DB・シークレットを読み書きできる
- **デプロイ SA の権限**（[`platform/terraform/deployer.tf`](platform/terraform/deployer.tf)）— `fga-deployer` が Security Rules を反映できる、プロジェクトの IAM を変えられる、シークレットの値を読めるなど、意図した最小権限を越える経路
- **Workload Identity Federation**（[`platform/terraform/bootstrap/github_wif.tf`](platform/terraform/bootstrap/github_wif.tf)）— デプロイ用ブランチ以外（PR のブランチ・fork・他のリポジトリ）からサービスアカウントを借用できる
- **GitHub Actions**（[`.github/workflows/`](.github/workflows/)）— 入力の埋め込みによるコマンド実行、承認（Environment）を通らない Terraform の apply
- **ポリシーチェックのすり抜け**（[`platform/policies/check.mjs`](platform/policies/check.mjs)）— HTTP 関数・全開放の Rules・他のアプリのサイトや DB への参照が、検査を通ってしまう書き方。正規表現による簡易検査なので、すり抜けは起こりえます。IAM と CODEOWNERS のレビューが後ろで止める前提ですが、報告は歓迎します
- **news-watcher の SSRF 対策**（[`apps/news-watcher/functions/src/lib/safeFetch.ts`](apps/news-watcher/functions/src/lib/safeFetch.ts)）— 内部 IP・メタデータサーバーへ到達できる URL

## 既知の限界（設計として受け入れているもの）

次は [docs/platform_design.md](docs/platform_design.md) §3.2 と §9 に書いてある既知の限界で、報告は不要です（より良い緩和策の提案は歓迎します）。

- Hosting のデプロイ権限・関数の新規作成・`run.services.setIamPolicy` は、プロジェクト単位でしか付けられない。デプロイ SA は、他のアプリの画面や関数を上書きできる（CI からだけ呼ぶ運用と、ポリシーチェックで緩和する）
- 関数のビルドは Compute Engine の既定 SA で動く
- Firebase Auth は全アプリで共通（アプリごとの認可は、各 DB の `members` と Rules で行う）

## 対象外

- Firebase・Google Cloud・`firebase-tools`・Terraform プロバイダそのものの脆弱性 — それぞれの提供元に報告してください
- このリポジトリをコピーした利用者が、自分で緩めた設定に起因するもの
- 依存パッケージの既知の脆弱性のうち、[`osv-scanner.toml`](osv-scanner.toml) に理由つきで例外にしているもの（理由が誤っている、という指摘は歓迎します）

## サポートするバージョン

修正は `main` の最新に入れます。テンプレートからコピーしたリポジトリには自動では届かないので、[`CHANGELOG.md`](CHANGELOG.md) を見て取り込んでください。
