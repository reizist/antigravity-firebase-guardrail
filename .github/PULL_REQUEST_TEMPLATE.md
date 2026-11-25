## 変更の概要

- アプリ（app id）：
- 種類：[ ] 新しいアプリ（データベースを作る） / [ ] 既存のアプリの変更 / [ ] Security Rules の変更 / [ ] 基盤・ドキュメント

---

## データの取り扱いの確認（アプリを追加・変更する PR では必須）

> Tier 0 のデータベースは、社内一般の情報だけを置く場所です。データベースを新しく作ると、監査ログ（`CreateDatabase`）から管理者に通知されます。

- [ ] **個人情報・顧客データ・未公開の財務情報・社外秘のファイル**をデータベースに保存しません（当てはまるなら Tier 1 / 2 としてエンジニア組織に相談します）
- [ ] 台帳に `data_class`・`handles_pii: false`・`expires`（有効期限）を書きました
- [ ] 一時的なデータは `ttl_collections`（`expiresAt` で自動削除）を設定したか、残さない作りにしました
- [ ] 外部のサービスへ社内のデータを送りません（送るなら台帳の `external_egress` に書き、`platform/catalog/apps.yaml` でレビューを受けます）
- [ ] 秘密情報（API キー・Webhook URL など）をコード・`firebase.json`・Firestore に書いていません
- [ ] `firebase emulators:start --project demo-<app>`（本番につながない）で動きを確かめました

## 確かめたこと

<!-- pnpm policy / pnpm test の結果、エミュレータで操作した内容、依存を足したならその理由 -->
