# build-firebase-app — 構成と名前の付け方

見本は `apps/news-watcher/`。新しいアプリ（app id を `<app>` とする）は、同じ構成で作る。

## 名前の付け方（app id = `link-collection` の例）

| もの | 決まり | 例 |
|---|---|---|
| app id | 英小文字で始まり英小文字か数字で終わる、英小文字・数字・ハイフンの 4〜20 文字。ハイフンを除くと他のアプリと同じになる id は不可 | `link-collection` |
| ディレクトリ | `apps/<app>/` | `apps/link-collection/` |
| Hosting サイト | `<site_prefix>-<app>`（`site_prefix` は `platform/config.json`） | `fga-link-collection` |
| Firestore データベース | `<app>`（`(default)` は存在しない。必ず名前を指定する） | `link-collection` |
| Functions の codebase | `<app>` | `link-collection` |
| 関数の export | `export const <appのcamelCase> = { ... }` の 1 グループだけ。関数名は `<camelCase>-<名前>` になる | `export const linkCollection = { onLinkCreated: ... }` |
| 実行 SA | `app-<app>@<project_id>.iam.gserviceaccount.com`（省略せずに書く） | `app-link-collection@…` |
| シークレット | 台帳の `secrets` の名前 → `<APP>_<名前>`（英大文字・アンダースコア） | `slack-webhook-general` → `LINK_COLLECTION_SLACK_WEBHOOK_GENERAL` |
| エミュレータのプロジェクト | `demo-<app>` | `demo-link-collection` |

## ファイル構成

```text
apps/<app>/
├── firebase.json            # 見本から写し、site / database / codebase を自分の名前にする
├── .firebaserc              # {"projects": {"default": "demo-<app>", "emulator": "demo-<app>"}}
├── firestore.rules          # 独自の Rules（rules_template: custom）のときだけ。新しく書く（下の雛形から）
├── firestore.standard.rules # 標準テンプレートのときだけ。platform/rules-templates/<名前>.rules をそのまま写す（書き換えない）
├── firestore.indexes.json   # 複合インデックス・TTL が要るときに書く（なければ {"indexes": [], "fieldOverrides": []}）
├── web/                     # 画面（素の TypeScript ＋ esbuild。依存は firebase だけ）
│   ├── package.json         # 見本から写し、name を @fga/<app>-web にする
│   ├── tsconfig.json        # 見本から写す
│   ├── build.mjs            # 見本から写す
│   ├── index.html / style.css
│   └── src/
│       ├── firebase.ts      # 見本から写し、DATABASE_ID と demo-<app> を変える
│       └── main.ts …        # 新しく書く
└── functions/               # 関数（Firestore トリガーと onSchedule だけ）
    ├── package.json         # 見本から写し、name を @fga/<app>-functions にする。使わない devDependencies は消す
    ├── tsconfig.json        # 見本から写す
    ├── build.mjs            # 見本から写す（esbuild で lib/index.js の 1 ファイルにまとめる）
    ├── src/
    │   ├── config.ts        # 見本から写し、APP_ID・DATABASE_ID・シークレット名を変える
    │   ├── index.ts         # 関数の定義（下の雛形）
    │   └── …                # 処理の本体（Firestore を読み書きする部分と、純粋なロジックを分ける）
    └── test/                # Vitest（ロジックの単体テスト）
```

`firebase.json` で変えるのは 3 か所だけ：`hosting.site`（`<site_prefix>-<app>`）、`firestore[].database`（`<app>`）、`functions[].codebase`（`<app>`）。標準テンプレートのアプリは、もう 1 か所 `firestore[].rules` を `firestore.standard.rules` にする。`storage` や `hosting.rewrites` で関数を呼ぶ設定は足さない。

## Security Rules の雛形（`firestore.rules`）

標準テンプレート（`internal-team-collab` / `internal-author-only`）で足りるアプリは、この節は要らない。テンプレートが許すのは次の形だけなので、画面と関数をそれに合わせる。

| コレクション | 書けること |
|---|---|
| `items/{id}` | 作成時に `createdBy` に自分のメールアドレス（小文字）を入れる。項目は 30 個まで。`createdBy` は後から変えられない |
| `requests/{id}` | 処理の依頼。`requestedBy` に自分のメールアドレス、`status: "pending"` で作成だけできる（項目は 15 個まで）。結果は関数が書く |
| `config/{id}` | 全員が読める設定。変更は admin だけ |
| `members/{email}` | 役割（`viewer` / `editor` / `admin`）。変更は admin だけ |

独自の Rules を書くとき（`rules_template: custom`）は、下の雛形から始める。

`isInternal()` の 3 つの条件と、ドメインの書き方（`.` を `[.]` にする）は変えない。ドメインは `platform/config.json` の `internal_domain` と同じにする。**すべての `allow` は、`isInternal()` か、それを必ず通る関数（`isEditor()` など）を `&&` の先頭に置く**（`||` で別の条件を並べない）。

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // 社内ドメインの、メール確認済みの Google アカウントだけ（全ルールの前提）
    function isInternal() {
      return request.auth != null
        && request.auth.token.email_verified == true
        && request.auth.token.email.lower().matches('.*@example[.]com$');
    }

    function myEmail() {
      return request.auth.token.email.lower();
    }

    function memberPath() {
      return /databases/$(database)/documents/members/$(myEmail());
    }

    // members/{email} に登録がなければ viewer（社内の人なら誰でも読める）
    function role() {
      return exists(memberPath()) ? get(memberPath()).data.role : 'viewer';
    }

    function isEditor() {
      return isInternal() && role() in ['editor', 'admin'];
    }

    function isAdmin() {
      return isInternal() && role() == 'admin';
    }

    // ---- アプリのデータ（例） ---------------------------------------------------
    // 利用者が書ける項目を hasOnly で限定し、型と長さを確かめる。関数だけが書く項目は利用者に書かせない
    match /items/{itemId} {
      allow read: if isInternal();
      allow create: if isEditor()
        && request.resource.data.keys().hasOnly(['title', 'url', 'createdBy', 'createdAt'])
        && request.resource.data.createdBy == myEmail();
      allow update, delete: if isEditor();
    }

    // ---- 画面からの処理の依頼（作成だけ。処理は Firestore トリガーの関数） -------
    match /requests/{requestId} {
      allow read: if isInternal();
      allow create: if isInternal()
        && request.resource.data.keys().hasOnly(['itemId', 'requestedBy', 'status', 'createdAt'])
        && request.resource.data.requestedBy == myEmail()
        && request.resource.data.status == 'pending';
      allow update, delete: if false;
    }

    // ---- メンバー（最初の admin は、台帳の admins から基盤が登録する） -----------
    match /members/{email} {
      allow read: if isInternal() && (email == myEmail() || isAdmin());
      allow write: if isAdmin()
        && (request.resource == null
            || (request.resource.data.role in ['viewer', 'editor', 'admin']
                && request.resource.data.email == email));
    }

    // 上に書いたもの以外はすべて拒否
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## 関数の雛形（`functions/src/index.ts`）

```typescript
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { DATABASE_ID, LABELS, REGION, RUNTIME_SERVICE_ACCOUNT, TIME_ZONE } from "./config.js";

initializeApp();
const db = () => getFirestore(DATABASE_ID);

/** 全関数に共通の設定（実行 SA・リージョン・ラベル・同時実行数の上限は必須） */
const common = {
  region: REGION,
  serviceAccount: RUNTIME_SERVICE_ACCOUNT, // app-<app>@<project_id>.iam.gserviceaccount.com
  labels: LABELS, // { app: "<app>" }
  maxInstances: 2,
  memory: "512MiB",
} as const;

export const linkCollection = {
  /** 画面からの依頼（requests に 1 件作られる）を処理する。HTTP 関数は作らない */
  onRequestCreated: onDocumentCreated(
    { ...common, document: "requests/{requestId}", database: DATABASE_ID, timeoutSeconds: 60 },
    async (event) => {
      const req = event.data?.data();
      if (!req) return;
      // 処理して、結果を依頼のドキュメントに書き戻す（status: done / error）
      await db().collection("requests").doc(event.params.requestId).update({ status: "done" });
    },
  ),

  /** 定期実行 */
  daily: onSchedule(
    { ...common, schedule: "0 9 * * 1-5", timeZone: TIME_ZONE, timeoutSeconds: 300, retryCount: 0 },
    async () => {
      // 1 回の実行で処理する件数に上限を設ける
    },
  ),
};
```

- Firestore トリガーには必ず `database: DATABASE_ID` を付ける（付けないと、存在しない `(default)` を見に行く）
- シークレットを使う関数は、`defineSecret("<APP>_<名前>")` を `secrets: [...]` に渡す。名前は台帳の `secrets` と対応させる
- `functions/package.json` の `dependencies` は `firebase-admin` と `firebase-functions` の 2 つだけ（版は固定）。ほかは `devDependencies` に置き、esbuild がバンドルする。クラウド側のビルドでインストールされる依存を最小限にするため

## 画面（`web/`）

- Firebase の設定（API キーなど）はコードに書かず、Hosting の予約 URL `/__/firebase/init.json` から読む（見本の `web/src/firebase.ts`）。`localhost` ではエミュレータにつなぐ
- ログインは Google ログインだけ。`hd` に社内ドメインを指定し、ログイン後にメールアドレスのドメインも確かめる（見本の `web/src/main.ts`）。これは使い勝手のためで、データを守っているのは Rules
- Firestore は `getFirestore(app, DATABASE_ID)` で、自分のデータベースを指定する
- UI ライブラリやフレームワークは足さない（依存の許可リストにない）。素の TypeScript と、ブラウザ標準の `<dialog>` などで作る
- 画面のファイル（HTML / JS）は認証なしで誰でも取得できる。機密情報を画面のコードに入れない
