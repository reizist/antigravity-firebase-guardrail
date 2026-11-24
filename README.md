# antigravity-firebase-guardrail

[Google Antigravity](https://antigravity.google) などの AI エージェントで社内アプリを量産するための、**Firebase のガードレール基盤**です。1 つの Firebase 共有プロジェクトに、複数のアプリを「テナント」として分離して同居させます。

長い規約書を配る代わりに、**ガードレール基盤（Terraform・スクリプト・CI）と、立場別の 2 つの [Agent Skill](https://antigravity.google/docs/skills) を同じリポジトリに入れて**あります。エンジニアもアプリを作る人も、このリポジトリを AI に読ませて、対話しながら進めます。

> [!IMPORTANT]
> これは検証用のサンプルで、Google の公式にサポートされたプロダクトではありません。内容は作者個人の見解に基づきます。
> 検証済みの範囲と、まだ実機で確かめていない範囲は「[検証の状況](#検証の状況)」を見てください。

## 考え方

- **手順の再現と実装パターンの誘導は、Agent Skill に任せる**（AI への指示）
- **越えてはならない境界は、仕組みで押さえる**（Terraform・IAM・ビルド設定・CI）。AI の出力がぶれても、権限と検査の側で止まる

```mermaid
flowchart LR
    REPO["このリポジトリ<br/>ガードレール基盤 ＋ 2つの Agent Skill"]

    subgraph DEV["エンジニア（初回の 1 回だけ）"]
        P1["「この repo を参考に<br/>Firebase の初期環境を構築して」"]
        S1["init-firebase-platform Skill<br/>共有プロジェクト・Terraform・<br/>WIF・最小権限 SA"]
        P1 --> S1
    end

    subgraph USER["アプリを作る人（何度でも）"]
        P2["「〇〇を要約するアプリを作って」"]
        S2["build-firebase-app Skill<br/>台帳に追記・HTTP 関数なしで実装・<br/>エミュレータで確認・PR"]
        P2 --> S2
    end

    REPO --> S1
    REPO --> S2
    S1 -->|"土台"| ENV[("Firebase 共有プロジェクト<br/>アプリごとにテナントを分離")]
    S2 -->|"CI の検査 ＋ Rules のレビュー"| ENV
```

## 構成

```text
.
├── AGENT.md                                 # リポジトリ全体の規約（AI が参照する基本方針）
├── .agents/
│   └── skills/
│       ├── init-firebase-platform/          # 【エンジニア向け】初回のガードレール構築 Skill
│       │   └── SKILL.md
│       └── build-firebase-app/              # 【アプリを作る人向け】アプリ量産 Skill
│           ├── SKILL.md
│           └── reference.md                 #   名前の付け方・Rules と関数の雛形
├── platform/
│   ├── config.json                          # 環境の値（プロジェクト ID・社内ドメインなど）はここ 1 か所
│   ├── catalog/apps.yaml                    # アプリ台帳（1 件追加するとテナントが払い出される）
│   ├── terraform/                           # 共有プロジェクト・WIF・デプロイ SA・テナント（modules/app-tenant）
│   └── policies/                            # CI のポリシーチェック・依存の許可リスト
├── apps/
│   └── news-watcher/                        # 第 1 号アプリ（RSS を Gemini で採点・要約して Slack に配信）
├── scripts/                                 # bootstrap / deploy / destroy
├── .github/                                 # ci.yml・deploy.yml・CODEOWNERS
├── docs/                                    # 設計・手順
└── pnpm-workspace.yaml                      # サプライチェーン対策（公開から 7 日待つ・スクリプトは許可制）
```

## ガードレール

| ガードレール | 何を防ぐか | どこで |
|---|---|---|
| **Security Rules の反映は Terraform だけ** | Rules の権限はプロジェクト単位でしか付けられない。アプリのデプロイ経路に渡すと、他のアプリの DB を全開放できてしまう | デプロイ SA に `firebaserules.*` の反映権限を付けない。`apps/*/firestore.rules` は CODEOWNERS でレビュー必須、反映は `deploy.yml` の platform ジョブ（承認つき） |
| **Tier 0 は HTTP 関数を作らない** | 認証チェック漏れ・公開設定ミス。画面からは Firestore に書き込み、Firestore トリガーと `onSchedule` で処理する | Skill ＋ `pnpm policy`（`onRequest` / `onCall` を検出） |
| **サプライチェーン対策** | 乗っ取られたパッケージ・`postinstall` の悪用。Functions はクラウド側で依存を入れ直すので、esbuild で 1 ファイルにまとめ、クラウド側で入る依存を 2 つに絞る | `pnpm-workspace.yaml`、依存の許可リスト、OSV-Scanner |
| **`(default)` DB・既定のバケットを作らない** | DB 名の指定を忘れたときに、共有の場所へ書き込むこと | Terraform（作らない）＋ デプロイ SA に DB を作る権限がない |
| **テナントごとの実行 SA と IAM Conditions** | 関数が他のアプリの DB・シークレットを読むこと | `modules/app-tenant` |
| **鍵なしのデプロイ（WIF）** | 手元の PC に本番の権限を置くこと。SA を借用できるのは `main` で動くワークフローだけ | `bootstrap/github_wif.tf`、`deploy.yml` |
| **台帳と有効期限** | 誰も管理していないアプリが残り続けること | `platform/catalog/apps.yaml`、`pnpm policy`（期限切れは CI が失敗） |

設計の詳細は [docs/platform_design.md](./docs/platform_design.md)、最小権限の `firebase deploy` でつまずいた点と対処は同 §9 にあります。

## 使い方

### エンジニア（最初に 1 回）

1. このリポジトリを「Use this template」で自分の GitHub にコピーし、clone する（業務で使うなら private にする）
2. Antigravity（または使っている AI エージェント）でリポジトリを開き、依頼する

   > このリポジトリと初期構築 Skill を参考に、Firebase のガバナンス付き共有プロジェクトの初期環境を構築して。クラウドへ反映する前に必ず差分を見せて確認して。

   明示的に呼ぶなら `/init-firebase-platform`。手作業で進めるなら [docs/runbook.md](./docs/runbook.md)。

必要なもの：課金を有効にできる Google Cloud のアカウント、`gcloud`・`terraform`・Node.js 24・`pnpm`。

### アプリを作る人（何度でも）

1. リポジトリを Antigravity で開く
2. 作りたいアプリを日本語で伝える

   > このリポジトリのアプリ量産 Skill を使って、Firebase アプリを作って。チーム向けに、毎朝チェックしたい公式ブログの RSS を要約して Slack に流したい。

3. 手元の画面（エミュレータ。本番にはつながらない）で動きを確かめ、直してほしい点を伝える
4. できあがったら「GitHub に PR を作って」と頼む

Google Cloud コンソールも Terraform も触りません。手元の PC に本番のデプロイ権限はなく、エンジニアが確認するのは基本的に **台帳（`apps.yaml`）と Security Rules（`firestore.rules`）の差分** です。マージされると CI が公開します。

必要なもの：GitHub アカウント、Antigravity、Node.js 24・`pnpm`、Java 21 以上（エミュレータ用）。

### 手元での確認

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm policy                     # ポリシーチェック
pnpm typecheck && pnpm test     # news-watcher の単体テスト
pnpm build
```

## 検証の状況

| 領域 | 状態 | 内容 |
|---|---|---|
| 共有基盤・テナント払い出し | 実機で検証済み（※） | Terraform（テナントの 7 リソースを一括作成）、`(default)` DB を作らない構成、Rules を Terraform で反映、Artifact Registry の npm リモートリポジトリ |
| 最小権限デプロイ・news-watcher | 実機で検証済み（※） | デプロイ SA ＋ `scripts/deploy_app.sh`、pnpm の保護設定 ＋ esbuild の 1 ファイルバンドル、news-watcher（Gemini の採点・要約、Slack への共有） |
| 公開にあたって一般化した部分 | **静的な検証のみ** | `platform/config.json` への設定の集約、WIF のブランチ単位の制限（`attribute.repo_ref`）、bash に書き直したスクリプト、GitHub Actions の `deploy.yml`。`terraform validate`・単体テスト・ポリシーチェック・CI は通っているが、この形のまま新しいプロジェクトに適用して確かめてはいない |
| CI のポリシーチェック | 実装済み（簡易） | 台帳・`firebase.json` の担当範囲・HTTP 関数の禁止・Rules・依存の許可リスト・秘密情報。文字列と正規表現による検査で、構文解析はしていない |
| まだ無いもの | 未実装 | Rules のユニットテスト（エミュレータ）、gitleaks、2 つ目のテナントでの分離の実機確認、Tier 1 の Storage バケット、App Check |

※ 作者の検証環境で、一般化する前の構成（プロジェクト ID などを直接書いた状態）で確認したものです。

## ライセンス

[Apache License 2.0](./LICENSE)
