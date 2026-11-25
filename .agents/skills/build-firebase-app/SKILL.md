---
name: build-firebase-app
description: 共有 Firebase 基盤の規約に沿って社内アプリを新規作成・検証し PR を作成する
---

# build-firebase-app — ガードレールの中で社内アプリを作る

アプリを作りたい人（エンジニアでなくてよい）の依頼を受けて、このリポジトリの `apps/<app>/` に新しい社内アプリを作り、手元で動かして確かめ、Pull Request を出すところまでを進める Skill。

相手は Google Cloud や Terraform を知らない前提で話す。専門用語を使うときは一言で説明し、判断が要るところ（アプリの名前・誰が使うか・扱うデータ）だけを質問する。

## 必須制約

- 実装前に個人情報・社外秘・外部送信・TTL を確認し、機密データは Tier 1/2 へ誘導する
- Tier 0 標準アプリは事前承認済み `rules_template` と `ttl_collections` を優先し、HTTP 関数を作らない
- 実行 SA は完全なメールアドレス表記、`maxInstances` と `labels: { app: "<app>" }` を必須とする
- 検証は `firebase emulators:exec --project demo-<app>` と `pnpm policy` で行い、ローカル本番デプロイしない

このほかに、必ず守ること：

- **本番を触るコマンドを実行しない**：`firebase deploy`、`terraform apply`、`gcloud` でのリソース変更、`scripts/deploy_*.sh`・`scripts/bootstrap_project.sh`・`scripts/destroy_platform.sh`。本番への反映は、PR がマージされた後に CI だけが行う
- **変更してよいのは `apps/<app>/` と、自分のアプリの台帳だけ**（`platform/catalog/self-service/<app>.yaml` の追加か、`platform/catalog/apps.yaml` への追記）。`platform/`（台帳以外）・`scripts/`・`.github/`・`.agents/`・`pnpm-workspace.yaml`・`.npmrc`・他のアプリのディレクトリと台帳は変更しない
- **Security Rules を緩めない**：標準テンプレートの写し（`firestore.standard.rules`）は書き換えない。独自の Rules を書くなら、全ルールが `isInternal()`（社内ドメインの確認）を通ること。`allow ...: if true` は書かない
- **依存を増やさない**：使えるのは `platform/policies/allowed-dependencies.json` にあるものだけ。足りないときは、理由を添えて PR でエンジニア組織に相談する（勝手に許可リストを書き換えない）
- **パッケージ管理は pnpm だけ**（`npm` / `npx` / `yarn` を使わない）。firebase-tools は `pnpm exec firebase` で使う
- **秘密情報（Webhook URL・API キーなど）をコード・Firestore・`firebase.json`・画面に書かない**。Secret Manager に置き、関数から `defineSecret` で読む
- **個人情報・お金・社外公開が絡むなら作り始めない**：Tier 0 で扱えるのは「社内一般（個人情報なし）」まで。当てはまるときは、エンジニア組織に相談するよう伝えて止まる（下の「レーンの判断」）

規約から外れた変更は CI のポリシーチェック（`pnpm policy`）と IAM が止めるが、止められてから直すより、最初から守るほうが早い。

## 進め方

### 1. 依頼を聞いて、扱うデータを確かめる（コードを書く前に必ず）

まず、アプリの内容を確かめる（依頼文から分かることは聞かない）。

| 確かめること | 使いみち |
|---|---|
| 何をするアプリか（1〜2 文） | 台帳の `description`、画面と関数の設計 |
| アプリの名前 | app id（英小文字で始まり英小文字か数字で終わる、英小文字・数字・ハイフンの 4〜20 文字。例: `link-collection`） |
| オーナー（責任を持つ人・グループ）と部署 | 台帳の `owners`・`admins`・`department` |

次に、**データの取り扱いを 4 点、必ず確かめる**。答えがあいまいなら、台帳やコードを書き始めない。

| # | 確かめること | 台帳の項目 |
|---|---|---|
| 1 | **個人情報**（氏名・連絡先・顧客の一覧）、**未公開の財務情報**、**契約書などの社外秘**をデータベースに保存するか | `handles_pii`・`data_class` |
| 2 | **外部のサービスへデータを送るか**（Slack・Google Chat への投稿、外部の API、RSS などの取得） | `external_egress`・`secrets` |
| 3 | **データをいつまで残すか**（一時的なデータは何日で消してよいか。迷ったら 90 日以内） | `ttl_collections` |
| 4 | **アプリをいつまで使うか**（棚卸しの期限。迷ったら 3〜6 か月後。延長できる） | `expires` |

**レーンの判断**

| 答え | 判断 |
|---|---|
| 1 が「いいえ」、2 が「いいえ」で、標準の Rules テンプレート（下の表）で足りる | **セルフサービス**。`platform/catalog/self-service/<app>.yaml` に登録する。エンジニア組織の承認を待たずに、データベースの払い出しと公開まで自動で進む |
| 2 が「はい」（外部への送信・シークレット）、または、標準のテンプレートでは足りず独自の Rules が要る | **エンジニア確認**。`platform/catalog/apps.yaml` に登録する。PR でエンジニア組織がレビューする、と伝えて進める |
| 1 のうち、社員の名前・メールアドレス程度を業務データとして持つ。ファイルのアップロードが要る | Tier 1。`platform/catalog/apps.yaml` に `tier: 1` で登録する PR で、エンジニア組織に相談する |
| 金額・領収書・口座情報・顧客情報、社外の人が使う、HTTP の API が必須 | Tier 2（専用プロジェクト）。この Skill では作らない。エンジニア組織に相談するよう伝えて止まる |

データベースを新しく作ると、監査ログから管理者に通知されることも伝える（隠れて作ることはできない）。

**標準の Rules テンプレート**（[`platform/rules-templates/`](../../../platform/rules-templates/)。エンジニア組織が事前に承認済み）

| `rules_template` | 向いているアプリ | コレクション |
|---|---|---|
| `internal-team-collab` | チームで共同編集する（リンク集、メモ、タスクの一覧） | `items`：社内の全員が読み書き。`requests`：処理の依頼（作成だけ）。`config`：設定（admin だけが変更）。`members` |
| `internal-author-only` | 全員が読めて、直せるのは書いた本人と admin だけ（投稿、アンケートの回答） | 同上（`items` の更新・削除は `createdBy` の本人と admin だけ） |

どちらも、`items` と `requests` 以外のコレクションは使えない。コレクションを増やしたい・項目ごとに細かく制御したいなら、独自の Rules（`rules_template: custom`）にしてエンジニア確認のレーンで進める。

### 2. 台帳に登録する

**セルフサービス**：`platform/catalog/self-service/<app>.yaml` を新しく作る（ファイル名が app id になる）。

```yaml
display_name: <表示名>
description: <何をするアプリか>
tier: 0
department: <部署>
data_class: internal
handles_pii: false
rules_template: internal-team-collab     # または internal-author-only
ttl_collections: [requests]              # 期限を過ぎたら消すコレクション（ドキュメントの expiresAt に期限を入れる）。なければ書かない
owners:
  - user:<オーナーのメール>              # 社内ドメインのアドレス。グループなら group:<メール>
admins:
  - <最初の管理者のメール>
expires: "YYYY-MM-DD"
```

**エンジニア確認**：`platform/catalog/apps.yaml` の `apps:` に 1 件追記する（既存のエントリは変更しない）。

```yaml
  <app>:
    display_name: <表示名>
    description: <何をするアプリか>
    tier: 0
    department: <部署>
    data_class: internal
    handles_pii: false
    rules_template: custom               # 標準のテンプレートで足りるなら、その名前
    external_egress: [slack-webhook-general]   # 外部への送信先の名前。なければ []
    ttl_collections: []
    owners:
      - group:fga-<app>-owners@<社内ドメイン>   # なければ user:<メール>
    admins:
      - <最初の管理者のメール>
    expires: "YYYY-MM-DD"
    secrets: [slack-webhook-general]     # Webhook などが要るときだけ。なければ []
```

台帳が基盤に反映されると、アプリ専用の Hosting サイト・Firestore データベース・実行用サービスアカウント・（あれば）シークレットの入れ物が払い出される。それまで本番では動かないが、**手元のエミュレータでの開発は今すぐ始められる**。

### 3. `apps/<app>/` を作る

`apps/news-watcher/` が、規約をすべて満たした見本。構成と名前の付け方は [reference.md](./reference.md) にまとめてある。**設定ファイルは見本から写して名前だけ変え、アプリ固有の部分（データ構造・Rules・関数・画面）を新しく書く**。

- 環境の値（プロジェクト ID・リージョン・社内ドメイン・サイトの接頭辞）は `platform/config.json` から読む。コードに直接書かない
- **標準の Rules テンプレートを使うアプリは、`firestore.rules` を書かない**。エミュレータ用に、テンプレートをそのまま写す（`cp platform/rules-templates/<テンプレート名>.rules apps/<app>/firestore.standard.rules`）。`firebase.json` の `firestore[].rules` は `firestore.standard.rules` にする。写しを書き換えても本番には反映されず、CI が止める
- 期限を過ぎたら消したいデータは、台帳の `ttl_collections` にコレクションを書き、ドキュメントの `expiresAt`（タイムスタンプ）に期限を入れる
- 画面からサーバー側の処理を頼むときは、「依頼」のドキュメントを Firestore に 1 件作り、Firestore トリガーの関数が処理して結果を書き戻す（見本の `shareRequests` → `onShareRequest`）
- 外部の URL を取りに行くなら、見本の `functions/src/lib/safeFetch.ts` を使う（内部ネットワークへのアクセスを防ぐ）。`fetch()` を直接呼ばない。外部への送信があるアプリは、セルフサービスでは作れない（エンジニア確認のレーン）
- Gemini を使うなら、Vertex AI（`@google/genai`）を `platform/config.json` のリージョンで呼び、リクエストに `labels: { app: "<app>" }` を付け、1 回の実行で呼ぶ件数に上限を設ける

### 4. 手元で確かめる（本番にはつながない）

```bash
pnpm install --frozen-lockfile     # 依存を足したときだけ pnpm install（ロックファイルの差分も PR に含める）
pnpm policy                        # 規約の確認とレーンの判定。違反（❌）が出たら直す
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
3. PR を作る。本文は [`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md) に沿って書き、「データの取り扱いの確認」を依頼者と一緒に 1 つずつ確かめてチェックを入れる
   - 何をするアプリか、誰が使うか、扱うデータ（手順 1 の 4 点の答え）
   - 手元で確かめたこと（エミュレータで操作した内容、テストの結果）
   - 依存を足したなら、その理由
   - エンジニア確認のレーンなら、**見てほしい差分**：`platform/catalog/apps.yaml`（台帳）と `apps/<app>/firestore.rules`（アクセス制御）。この 2 つは CODEOWNERS でレビューが必須
4. PR には、CI がデータの取り扱いの注意と判定（`AUTO_APPROVE_ELIGIBLE` / `ENGINEER_REVIEW_REQUIRED` / `BLOCKED`）をコメントする。`BLOCKED` なら、書かれた違反を直す
5. マージされると、CI が基盤への反映とアプリのデプロイを行う。セルフサービスのアプリは承認なしで進み、エンジニア確認のアプリは、エンジニア組織が反映の内容を承認してから進む。URL は `https://<site_prefix>-<app>.web.app`

シークレット（Webhook URL など）が要るアプリは、払い出された入れ物 `<APP>_<名前>` に、オーナーが値を登録する必要があると伝える（[docs/runbook.md](../../../docs/runbook.md) §5）。

## うまくいかないとき

| 症状 | 対処 |
|---|---|
| `pnpm policy` が違反を出す | メッセージのとおりに直す。規約のほうを変えない |
| `pnpm install` が `ERR_PNPM_IGNORED_BUILDS` や公開日の条件で止まる | 依存を足した結果。許可リストにない依存・公開から 7 日たっていない版は入らない。別の方法がないか考え、必要なら PR で相談する |
| エミュレータでログインできない・データが読めない | Rules の `isInternal()` は社内ドメインのメールアドレスだけを通す。テストユーザーのメールアドレスを確かめる |
| 本番で動かしたい・すぐ公開したい | PR を出してマージを待つ。手元からのデプロイは権限がなくてできない（そういう作りにしてある） |
