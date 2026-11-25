# セルフサービスの台帳

標準の型に収まる Tier 0 のアプリは、ここに `<app id>.yaml` を 1 つ置くだけで登録できる。エンジニア組織のレビューも、反映前の承認も要らない（[docs/platform_design.md §3.4](../../../docs/platform_design.md)）。

置けるのは、次をすべて満たすアプリだけ。1 つでも外れると CI のポリシーチェック（`pnpm policy`）が止めるので、そのときは [`../apps.yaml`](../apps.yaml) に登録してレビューを受ける。

- `tier: 0`、`data_class` は `public` か `internal`、`handles_pii: false`
- `rules_template` は標準テンプレート（`internal-team-collab` か `internal-author-only`）。`apps/<app id>/firestore.rules` は書かない（エミュレータ用に、テンプレートの写し `apps/<app id>/firestore.standard.rules` だけを置く）
- シークレット（`secrets`）と外部への送信（`external_egress`）がない
- `owners`・`admins` は社内ドメインのアドレス
- HTTP 関数がない、`safeFetch` を通さない `fetch()` がない

```yaml
# platform/catalog/self-service/link-collection.yaml
display_name: リンク集
description: チームでよく使うリンクとメモを共有する
tier: 0
department: sales
data_class: internal
handles_pii: false
rules_template: internal-team-collab   # 全員で編集。作った本人だけが直せるようにするなら internal-author-only
ttl_collections: [requests]            # （任意）expiresAt を過ぎたドキュメントを自動で消すコレクション
owners:
  - user:alice@example.com
admins:
  - alice@example.com
expires: "2027-06-30"
```

ファイル名（拡張子 `.yaml` を除いた部分）が app id になる。データベースが作られると、監査ログから管理者に通知される。
