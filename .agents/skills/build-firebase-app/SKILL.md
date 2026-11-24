---
name: build-firebase-app
description: 共有 Firebase 基盤の規約に沿って社内アプリを新規作成・検証し PR を作成する
---

# build-firebase-app — ガードレールの中で社内アプリを作る

アプリを作りたい人（エンジニアでなくてよい）の依頼を受けて、このリポジトリの `apps/<app>/` に新しい社内アプリを作り、手元で動かして確かめ、Pull Request を出すところまでを進める Skill。

相手は Google Cloud や Terraform を知らない前提で話す。専門用語を使うときは一言で説明し、判断が要るところ（アプリの名前・誰が使うか・扱うデータ）だけを質問する。

## 必須制約

- 新規アプリは `platform/catalog/apps.yaml` に登録する（`tier: 0`, `expires` 指定）
- Tier 0 では `onRequest` / `onCall` を作らず、Firestore トリガーと `onSchedule` のみで構成する
- 実行 SA は完全なメールアドレスで指定し、`maxInstances` と `labels: { app: "<app>" }` を付ける
- Functions の外部依存は `devDependencies` に寄せ、`esbuild` で `lib/index.js` へバンドルする
- 検証は `firebase emulators:exec --project demo-<app>` で実行し、ローカルから本番デプロイしない

このほかに、必ず守ること：

- **本番を触るコマンドを実行しない**：`firebase deploy`、`terraform apply`、`gcloud` でのリソース変更、`scripts/deploy_*.sh`・`scripts/bootstrap_project.sh`・`scripts/destroy_platform.sh`。本番への反映は、PR がマージされた後に CI だけが行う
- **変更してよいのは `apps/<app>/` と、台帳 `platform/catalog/apps.yaml` への自分のアプリの追記だけ**。`platform/`（台帳以外）・`scripts/`・`.github/`・`.agents/`・`pnpm-workspace.yaml`・`.npmrc`・他のアプリのディレクトリは変更しない
- **Security Rules を緩めない**：全ルールが `isInternal()`（社内ドメインの確認）を通ること。`allow ...: if true` は書かない
- **依存を増やさない**：使えるのは `platform/policies/allowed-dependencies.json` にあるものだけ。足りないときは、理由を添えて PR でエンジニア組織に相談する（勝手に許可リストを書き換えない）
- **パッケージ管理は pnpm だけ**（`npm` / `npx` / `yarn` を使わない）。firebase-tools は `pnpm exec firebase` で使う
- **秘密情報（Webhook URL・API キーなど）をコード・Firestore・`firebase.json`・画面に書かない**。Secret Manager に置き、関数から `defineSecret` で読む
- **個人情報・お金・社外公開が絡むなら作り始めない**：Tier 0 で扱えるのは「社内一般（個人情報なし）」まで。当てはまるときは、エンジニア組織に相談するよう伝えて止まる（下の「Tier の判断」）

規約から外れた変更は CI のポリシーチェック（`pnpm policy`）と IAM が止めるが、止められてから直すより、最初から守るほうが早い。

## 進め方

### 1. 依頼を聞いて、Tier を判断する

次を確かめる（依頼文から分かることは聞かない）。

| 確かめること | 使いみち |
|---|---|
| 何をするアプリか（1〜2 文） | 台帳の `description`、画面と関数の設計 |
| アプリの名前 | app id（英小文字で始まり英小文字か数字で終わる、英小文字・数字・ハイフンの 4〜20 文字。例: `link-collection`） |
| オーナー（責任を持つ人・グループ）と部署 | 台帳の `owners`・`admins`・`department` |
| 扱うデータ | Tier の判断 |
| いつまで使うか | 台帳の `expires`（迷ったら半年〜1 年後。延長できる） |

**Tier の判断**

| 扱うデータ・機能 | 判断 |
|---|---|
| 社内一般の情報だけ（ニュース、リンク集、アンケートの集計など） | **Tier 0**。このまま進める |
| 社員の名前・メールアドレスを業務データとして持つ、ファイルのアップロードが要る | Tier 1。エンジニア組織のレビューが要ると伝え、台帳の PR で相談する |
| 金額・領収書・口座情報・顧客情報、社外の人が使う、HTTP の API が必須 | Tier 2（専用プロジェクト）。この Skill では作らない。エンジニア組織に相談するよう伝えて止まる |

### 2. 台帳に登録する

`platform/catalog/apps.yaml` の `apps:` に 1 件追記する（既存のエントリは変更しない）。

```yaml
  <app>:
    display_name: <表示名>
    description: <何をするアプリか>
    tier: 0
    department: <部署>
    data_class: internal
    owners:
      - group:fga-<app>-owners@<社内ドメイン>   # なければ user:<メール>
    admins:
      - <最初の管理者のメール>
    expires: "YYYY-MM-DD"
    secrets: []          # Webhook などが要るときだけ。例: [slack-webhook-general]
```

台帳の PR がマージされて基盤に反映されると、アプリ専用の Hosting サイト・Firestore データベース・実行用サービスアカウント・シークレットの入れ物が払い出される。それまで本番では動かないが、**手元のエミュレータでの開発は今すぐ始められる**。

### 3. `apps/<app>/` を作る

`apps/news-watcher/` が、規約をすべて満たした見本。構成と名前の付け方は [reference.md](./reference.md) にまとめてある。**設定ファイルは見本から写して名前だけ変え、アプリ固有の部分（データ構造・Rules・関数・画面）を新しく書く**。

- 環境の値（プロジェクト ID・リージョン・社内ドメイン・サイトの接頭辞）は `platform/config.json` から読む。コードに直接書かない
- 画面からサーバー側の処理を頼むときは、「依頼」のドキュメントを Firestore に 1 件作り、Firestore トリガーの関数が処理して結果を書き戻す（見本の `shareRequests` → `onShareRequest`）
- 外部の URL を取りに行くなら、見本の `functions/src/lib/safeFetch.ts` を使う（内部ネットワークへのアクセスを防ぐ）
- Gemini を使うなら、Vertex AI（`@google/genai`）を `platform/config.json` のリージョンで呼び、リクエストに `labels: { app: "<app>" }` を付け、1 回の実行で呼ぶ件数に上限を設ける

### 4. 手元で確かめる（本番にはつながない）

```bash
pnpm install --frozen-lockfile     # 依存を足したときだけ pnpm install（ロックファイルの差分も PR に含める）
pnpm policy                        # 規約の確認。違反が出たら直す
pnpm typecheck && pnpm test && pnpm build

cd apps/<app>
pnpm exec firebase emulators:start --project demo-<app>          # 画面を見ながら確かめる（http://localhost:5000）
pnpm exec firebase emulators:exec --project demo-<app> "<テストのコマンド>"   # 起動 → テスト → 停止 をまとめて行う
```

- プロジェクト ID を `demo-` で始めると、エミュレータは本物のプロジェクトに一切つながらない。**必ず `--project demo-<app>` を付ける**
- エミュレータには Java 21 以上が要る。なければ、入れ方を案内する
- エミュレータの Auth では、社内ドメインのメールアドレスのテストユーザーでログインして確かめる。Rules は本番と同じものが効く
- 定期実行（`onSchedule`）はエミュレータでは自動で動かない。処理の本体を関数から切り出し、単体テストで確かめる
- Gemini（Vertex AI）はエミュレータの対象外。単体テストと画面の確認では、テスト用の差し替え（見本の `Scorer` インターフェース）を使う
- 画面をブラウザで開き、依頼された動きになっているかを実際に操作して確かめる。直してほしい点を聞き、直す

### 5. Pull Request を出す

1. `pnpm policy` と `pnpm test` が通ることをもう一度確かめる
2. 作業ブランチに commit する（`main` に直接 push しない。秘密情報・`.secret.local`・`*.tfvars` を含めない）
3. PR を作る。本文に次を書く
   - 何をするアプリか、誰が使うか、扱うデータ（Tier 0 の理由）
   - **エンジニア組織に見てほしい差分**：`platform/catalog/apps.yaml`（台帳）と `apps/<app>/firestore.rules`（アクセス制御）。この 2 つは CODEOWNERS でレビューが必須
   - 手元で確かめたこと（エミュレータで操作した内容、テストの結果）
   - 依存を足したなら、その理由
4. マージされると、CI が基盤への反映（承認つき）とアプリのデプロイを行う。URL は `https://<site_prefix>-<app>.web.app`

シークレット（Webhook URL など）が要るアプリは、払い出された入れ物 `<APP>_<名前>` に、オーナーが値を登録する必要があると伝える（[docs/runbook.md](../../../docs/runbook.md) §5）。

## うまくいかないとき

| 症状 | 対処 |
|---|---|
| `pnpm policy` が違反を出す | メッセージのとおりに直す。規約のほうを変えない |
| `pnpm install` が `ERR_PNPM_IGNORED_BUILDS` や公開日の条件で止まる | 依存を足した結果。許可リストにない依存・公開から 7 日たっていない版は入らない。別の方法がないか考え、必要なら PR で相談する |
| エミュレータでログインできない・データが読めない | Rules の `isInternal()` は社内ドメインのメールアドレスだけを通す。テストユーザーのメールアドレスを確かめる |
| 本番で動かしたい・すぐ公開したい | PR を出してマージを待つ。手元からのデプロイは権限がなくてできない（そういう作りにしてある） |
